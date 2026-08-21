import {inject, Injectable} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {firstValueFrom, Subject} from 'rxjs';
import {MlsReplayedMessage, MlsService} from './mls.service';
import {MlsTransportService} from './mls-transport.service';
import {MlsHealthService} from './mls-health.service';
import {DeviceIdentityService} from './device-identity.service';
import {trace} from '../core/log';
import {
    DeviceWelcomeDto,
    MlsContextStateDto,
    MlsEpochConflictDto,
    PendingWelcomeDto,
    PublishMlsCommitDto,
    UnreachableDeviceDto,
} from '../dtos/mls.dto';

/** A context whose group membership or encryption state just changed under us. */
export interface MlsContextChanged {
    contextId: string;
    isChannel: boolean;
    /** True when this device was removed from the group by someone else's commit. */
    selfRemoved: boolean;
}

/** How a commit-producing operation is described to {@link MlsSyncService.publish}. */
interface StagedCommit {
    commit: string;
    /** Epoch this commit establishes once merged. */
    epoch: number;
    /**
     * Welcomes for devices this commit adds. They travel with the commit so a device can never end
     * up holding a leaf in a group whose Welcome was lost on the way.
     */
    deviceWelcomes: DeviceWelcomeDto[];

    /** Join requests this commit admits. Closed by the server only when the commit lands. */
    fulfilledJoinRequestIds?: string[];

    /**
     * GroupInfo for the epoch this commit establishes, as produced by the commit itself.
     *
     * Not exported separately: an export can only describe the epoch the group is on now, and the
     * commit is staged rather than merged at this point.
     */
    groupInfo?: string | null;
}

/**
 * Everything that has to happen in a particular order for MLS to stay consistent.
 *
 * Three rules drive the whole class:
 *
 * 1. **Commits apply in epoch order, from the server.** The realtime push is only a nudge; group
 *    state advances solely by fetching commits above our local epoch and applying them in sequence.
 *    Applying them in arrival order would fork this device off the group permanently.
 * 2. **A commit is staged locally, published, and only then merged.** The server takes exactly one
 *    commit per epoch. Merging before it accepts means a lost race leaves us advanced on a commit
 *    nobody else has - unrecoverable in MLS. On rejection we discard, catch up, and re-issue.
 * 3. **A Welcome is acknowledged only after the join succeeds.** Its init key is single-use, so a
 *    Welcome consumed before a failed join locks this device out of the context for good.
 */
@Injectable({providedIn: 'root'})
export class MlsSyncService {
    /** Emits whenever a context's group changed - membership, or being removed from it. */
    readonly contextChanged = new Subject<MlsContextChanged>();

    /**
     * Messages that arrived before the commit that made them readable, now decrypted.
     *
     * Without this they were dropped: a message decrypts from the wire exactly once, so an
     * application message that raced ahead of its commit was unreadable for good.
     */
    readonly replayedMessages = new Subject<{contextId: string; messages: MlsReplayedMessage[]}>();

    private readonly mls = inject(MlsService);
    private readonly transport = inject(MlsTransportService);
    private readonly health = inject(MlsHealthService);
    private readonly deviceIdentity = inject(DeviceIdentityService);

    /**
     * One in-flight operation per context.
     *
     * A realtime nudge and a launch-time sweep routinely target the same context at once; letting
     * both walk the commit list would apply the same commit twice, and the second application
     * fails and looks like corruption.
     */
    private readonly queues = new Map<string, Promise<unknown>>();

    /** Contexts that picked up a Remove proposal during catch-up and still owe a commit for it. */
    private readonly pendingProposalContexts = new Set<string>();

    // -------------------------------------------------------------------------
    // Welcomes
    // -------------------------------------------------------------------------

    /**
     * Joins every group this device has been invited to, then acknowledges only the ones that
     * actually worked.
     *
     * A Welcome that fails to join is deliberately left unacknowledged so the next attempt sees it
     * again - the alternative is losing the only copy of a single-use key.
     */
    async processPendingWelcomes(): Promise<void> {
        const keyHandle = this.mls.keyHandle();
        if (!keyHandle) return;

        const deviceId = await this.deviceIdentity.deviceId();
        const welcomes = await firstValueFrom(this.transport.getPendingWelcomes(deviceId));
        if (welcomes.length === 0) return;

        const joined: string[] = [];

        for (const welcome of welcomes) {
            if (await this.joinFromWelcome(welcome, keyHandle)) joined.push(welcome.id);
        }

        if (joined.length > 0) await firstValueFrom(this.transport.ackWelcomes(joined, deviceId));
    }

    /** @returns whether the join succeeded and the Welcome may be acknowledged. */
    private async joinFromWelcome(welcome: PendingWelcomeDto, keyHandle: string): Promise<boolean> {
        const isChannel = !!welcome.channelId;

        try {
            const existing = await this.mls.getGroupId(welcome.contextId, welcome.generation);
            if (existing) {
                // Already joined this generation on a previous run that died before acking.
                // Acknowledging is right: re-joining would fail, and leaving it pending would make
                // every future sweep retry a join that can never succeed.
                return true;
            }

            const info = await firstValueFrom(this.mls.joinGroup(welcome.welcome, keyHandle));
            await this.mls.registerGroup(welcome.contextId, welcome.generation, info.groupId);

            // The Welcome drops us in at its own epoch; anything committed since has to be replayed
            // before we can read current traffic.
            await this.syncContext(welcome.contextId, isChannel);
            this.health.recordSuccess(welcome.contextId);
            return true;
        } catch (err) {
            // Counted and surfaced, not logged and forgotten. A device that can never join logged
            // one line per launch and told its owner nothing, so the only reportable symptom was
            // "sometimes messages don't arrive".
            this.health.recordFailure(welcome.contextId, isChannel, 'join-failed', err);
            console.error('Failed to join MLS group from Welcome', welcome.contextId, err);
            return false;
        }
    }

    // -------------------------------------------------------------------------
    // Catch-up
    // -------------------------------------------------------------------------

    /**
     * Applies every commit the server holds above this device's local epoch, in order.
     *
     * Pages until the server stops returning a full page, so a device that was offline across more
     * commits than one page holds still converges rather than silently stopping partway.
     */
    async syncContext(contextId: string, isChannel: boolean): Promise<void> {
        await this.serialized(contextId, async () => {
            await this.syncContextInner(contextId, isChannel);
            await this.replayBufferedMessages(contextId);
        });

        // Outside the queue, because committing publishes and publishing takes the same queue.
        if (this.pendingProposalContexts.delete(contextId)) {
            try {
                await this.commitPendingProposals(contextId, isChannel);
            } catch (err) {
                // Any other member can do this instead; leaving it undone only delays the removal.
                console.error('Could not commit pending proposals', contextId, err);
            }
        }
    }

    private async syncContextInner(contextId: string, isChannel: boolean): Promise<void> {
        const generation = await this.mls.getKnownGeneration(contextId);
        if (generation === null) return;

        const groupId = await this.mls.getGroupId(contextId, generation);
        if (!groupId) return;

        for (;;) {
            let epoch: number;
            try {
                epoch = (await firstValueFrom(this.mls.getGroupInfo(groupId))).epoch;
            } catch {
                // The group is gone locally - removed, or the context was wiped. Nothing to catch up.
                return;
            }

            const commits = await firstValueFrom(
                this.transport.getCommits(contextId, isChannel, epoch, generation),
            );
            if (commits.length === 0) return;

            let applied = 0;
            for (const entry of commits) {
                // The server says which rows are proposals rather than the client inferring it from
                // what the engine makes of the bytes. A proposal claims no epoch - the server's
                // epoch index is filtered on `is_proposal = false` - so it is exempt from the
                // sequence check, and the real commit behind it legitimately carries the same
                // epoch number.
                if (entry.isProposal) {
                    await this.applyProposal(contextId, isChannel, groupId, entry.commit);
                    continue;
                }

                // Strictly sequential. A gap means the page started above our epoch, which should be
                // impossible - stopping is safer than applying out of order.
                if (entry.epoch !== epoch + applied + 1) break;

                const outcome = await this.applyCommit(contextId, isChannel, groupId, entry.commit);
                if (outcome === 'self-removed') return;

                // Belt to the flag's braces: a server that predates it, or a payload the engine
                // reads as a proposal regardless, must still not count as progress. Counting one
                // meant the next page was fetched from the same `sinceEpoch`, returned the same
                // row, and counted it again - the loop never terminated, and every later commit was
                // refused forever, so the group could never gain a member again.
                if (outcome === 'commit') applied++;
            }

            if (applied === 0) return;
        }
    }

    /**
     * Hands back any message that arrived ahead of the commits just applied.
     *
     * Runs inside the context queue, immediately after catch-up, because that is the only moment
     * the group is known to have moved.
     */
    private async replayBufferedMessages(contextId: string): Promise<void> {
        const groupId = await this.mls.getActiveGroupId(contextId);
        if (!groupId) return;

        try {
            const messages = await firstValueFrom(this.mls.drainPendingMessages(groupId));
            if (messages.length > 0) this.replayedMessages.next({contextId, messages});
        } catch (err) {
            // Losing the buffer is bad but not worth failing a catch-up over - the commits that
            // were just applied are the part that keeps this device in the group.
            console.error('Could not replay buffered MLS messages', contextId, err);
        }
    }

    /**
     * Queues a departing member's Remove proposal for someone to commit.
     *
     * Failures are swallowed on purpose. A proposal is only valid in the epoch it was built
     * against, so one that arrives after the group has moved on is simply stale - and letting that
     * abort the catch-up would stop this device applying the commits it actually needs.
     */
    private async applyProposal(
        contextId: string,
        isChannel: boolean,
        groupId: string,
        proposalB64: string,
    ): Promise<void> {
        try {
            await firstValueFrom(this.mls.processMessage(groupId, proposalB64));
            // Committed outside the queue this method is holding - see syncContext.
            this.pendingProposalContexts.add(contextId);
        } catch (err) {
            console.warn('Ignoring an MLS proposal this device cannot apply', contextId, err);
        }
    }

    /** What a fetched entry turned out to be, and whether it left us in the group. */
    private async applyCommit(
        contextId: string,
        isChannel: boolean,
        groupId: string,
        commitB64: string,
    ): Promise<'commit' | 'proposal' | 'self-removed'> {
        const processed = await firstValueFrom(this.mls.processMessage(groupId, commitB64));

        if (processed.kind === 'proposal') {
            // A departing member's Remove-self proposal. MLS does not let anyone commit their own
            // removal, so until a remaining member turns this into a commit the group keeps
            // encrypting to someone who has already thrown their keys away. Queued rather than
            // committed inline: we are mid-catch-up here, and publishing needs the queue this
            // method is already holding.
            this.pendingProposalContexts.add(contextId);
            return 'proposal';
        }

        if (processed.kind !== 'commit') return 'proposal';

        if (processed.selfRemoved) {
            // We are out. The group's keys are useless from here, and holding them would only let a
            // stale UI claim it can still read the context.
            await this.mls.clearActiveGeneration(contextId);
            try {
                await firstValueFrom(this.mls.deleteGroup(groupId));
            } catch (err) {
                console.error('Failed to delete group after removal', contextId, err);
            }
            this.health.recordFailure(contextId, isChannel, 'removed');
            this.contextChanged.next({contextId, isChannel, selfRemoved: true});
            return 'self-removed';
        }

        if (processed.addedMembers.length > 0 || processed.removedLeafIndices.length > 0) {
            this.contextChanged.next({contextId, isChannel, selfRemoved: false});
        }

        return 'commit';
    }

    // -------------------------------------------------------------------------
    // Reading
    // -------------------------------------------------------------------------

    /**
     * Decrypts one application message, in order with everything else happening to the context.
     *
     * <p>Two things this fixes. First, ordering: decrypts used to be issued straight from the
     * socket handler and from history paging, outside the per-context queue that commits run under,
     * so an application decrypt could interleave between the stage and the merge of a two-phase
     * commit. Second, the sender check: `verifySenderInRoster` existed with no call sites, so the
     * documented anti-spoofing guard was applied on no decrypt path at all.</p>
     *
     * @returns the plaintext (base64), or null when the message is not readable on this device.
     */
    async decryptMessage(
        contextId: string,
        isChannel: boolean,
        groupId: string,
        ciphertextB64: string,
        messageId: string,
        expectedSenderUserId?: string,
    ): Promise<string | null> {
        return this.serialized(contextId, async () => {
            let processed;
            try {
                processed = await firstValueFrom(this.mls.processMessage(groupId, ciphertextB64, messageId));
            } catch (err) {
                // Routine at the edge of the ratchet - a message paged in from beyond its reach can
                // never be decrypted - so it is counted rather than shouted about. What matters is
                // whether failures keep accruing without a success in between.
                this.health.recordFailure(contextId, isChannel, 'decrypt-failed', err);
                return null;
            }

            // Early, not broken: it is held and replayed once its commit lands.
            if (processed.kind === 'buffered') return null;
            if (processed.kind !== 'application' || !processed.plaintext) return null;

            if (!this.senderMatchesClaimedAuthor(processed.senderIdentity, expectedSenderUserId)) {
                this.health.recordFailure(
                    contextId,
                    isChannel,
                    'decrypt-failed',
                    `the server attributed this message to ${expectedSenderUserId}, but it was ` +
                        `signed by ${processed.senderIdentity}`,
                );
                return null;
            }

            this.health.recordSuccess(contextId);
            return processed.plaintext;
        });
    }

    /**
     * Whether the credential that actually signed the message matches who the server says sent it.
     *
     * <p>This is the check that does work, and it is deliberately *not* a roster lookup. An earlier
     * version also asked whether `senderIdentity` appeared in `getMembers()` and its comment claimed
     * that stopped a malicious server spoofing a credential. It does not, and could not: openmls
     * resolves the sender from a leaf in the ratchet tree and verifies the message signature against
     * that leaf's key before `process_message` returns at all. Anything that reaches us has already
     * been proved to come from a current member, so re-asking is a tautology - it can only ever
     * return true, and dressing it up as an anti-spoofing guard hid the fact that nothing was
     * guarding that direction.</p>
     *
     * <p>What is genuinely unverified is the *envelope*: `authorId` is a plain server field sitting
     * next to the ciphertext, and the UI attributes the message to it. Comparing it against the
     * authenticated credential is what stops the server captioning one member's ciphertext with
     * another member's name. Note the credential carries a user id, not a device id, so this cannot
     * distinguish two devices of the same user - a limit worth stating rather than implying.</p>
     */
    private senderMatchesClaimedAuthor(
        senderIdentity: string | null,
        expectedSenderUserId?: string,
    ): boolean {
        if (!senderIdentity) return false;
        if (!expectedSenderUserId) return true;
        return senderIdentity === expectedSenderUserId;
    }

    // -------------------------------------------------------------------------
    // Publishing
    // -------------------------------------------------------------------------

    /**
     * Stages a commit, publishes it, and merges it only if the server took it.
     *
     * On a rejected epoch the staged commit is discarded, this device catches up to whatever won,
     * and `produce` is called again against the new state. One retry: a second rejection means
     * something is contending hard enough that retrying in a loop would just make it worse.
     */
    async publish(
        contextId: string,
        isChannel: boolean,
        produce: () => Promise<StagedCommit>,
    ): Promise<boolean> {
        return this.serialized(contextId, async () => {
            if (await this.attemptPublish(contextId, isChannel, produce)) return true;

            await this.syncContextInner(contextId, isChannel);
            return this.attemptPublish(contextId, isChannel, produce);
        });
    }

    private async attemptPublish(
        contextId: string,
        isChannel: boolean,
        produce: () => Promise<StagedCommit>,
    ): Promise<boolean> {
        const generation = await this.mls.getKnownGeneration(contextId);
        if (generation === null) return false;

        const groupId = await this.mls.getGroupId(contextId, generation);
        if (!groupId) return false;

        const staged = await produce();

        const dto: PublishMlsCommitDto = {
            epoch: staged.epoch,
            commit: staged.commit,
            senderDeviceId: await this.deviceIdentity.deviceId(),
            generation,
            welcomes: staged.deviceWelcomes,
            fulfilledJoinRequestIds: staged.fulfilledJoinRequestIds ?? [],
            // Straight from the commit, which is the only source that describes the epoch the
            // commit *establishes*. Exporting one here instead described the epoch the group is
            // still on - the commit has deliberately not been merged yet - so every published
            // GroupInfo was one behind and a device recovering by external commit landed stale.
            groupInfo: staged.groupInfo ?? null,
        };

        if (!(await this.publishCommitIdempotently(contextId, isChannel, dto, groupId))) return false;

        // Past this point the server holds the commit, so the local group *must* advance to match.
        // Discarding here - which is what the single try/catch around both calls used to do - left
        // this device permanently behind a commit everyone else had applied, with no way back:
        // MLS has no mechanism for rejoining an epoch you refused.
        await firstValueFrom(this.mls.mergePendingCommit(groupId));
        return true;
    }

    /**
     * Publishes, and works out whether the server took it even when the response never arrived.
     *
     * Publishing is idempotent on (senderDeviceId, generation, epoch, payload), so re-sending the
     * same bytes either confirms the stored row or reports the epoch as taken. That is the whole
     * point: a lost response used to be indistinguishable from a rejection, and the client
     * resolved it by discarding a commit the server had actually accepted.
     *
     * @returns true when the commit is on the server; false when the epoch was lost and the caller
     *          should catch up and re-issue.
     */
    private async publishCommitIdempotently(
        contextId: string,
        isChannel: boolean,
        dto: PublishMlsCommitDto,
        groupId: string,
    ): Promise<boolean> {
        try {
            await firstValueFrom(this.transport.publishCommit(contextId, isChannel, dto));
            return true;
        } catch (err) {
            if (this.isEpochConflict(err)) {
                await this.discardStagedCommit(groupId);
                return false;
            }

            try {
                const result = await firstValueFrom(this.transport.publishCommit(contextId, isChannel, dto));
                // `duplicate` means the server matched this exact payload from this device and
                // returned the row it already held. That is a *success*, and the distinction is
                // what the flag is for: the first attempt did land, the response was simply lost,
                // and treating it as a lost race is what used to discard a commit the group had
                // already applied.
                if (result.duplicate) {
                    trace('The first publish landed after all; keeping the staged commit', contextId);
                }
                return true;
            } catch (retryErr) {
                // Two failures. Either it never landed or we cannot find out - and a staged commit
                // left behind blocks every later operation on this group, so the group is restored
                // to a usable state and the caller is told plainly.
                await this.discardStagedCommit(groupId);
                if (this.isEpochConflict(retryErr)) return false;
                throw retryErr;
            }
        }
    }

    private async discardStagedCommit(groupId: string): Promise<void> {
        try {
            await firstValueFrom(this.mls.clearPendingCommit(groupId));
        } catch (err) {
            console.error('Failed to discard a rejected staged commit', groupId, err);
        }
    }

    private isEpochConflict(err: unknown): err is HttpErrorResponse {
        return err instanceof HttpErrorResponse && err.status === 409;
    }

    /** The server's view of where the group actually is, when it rejected ours. */
    epochConflictOf(err: unknown): MlsEpochConflictDto | null {
        return this.isEpochConflict(err) ? (err.error as MlsEpochConflictDto) : null;
    }

    // -------------------------------------------------------------------------
    // Membership
    // -------------------------------------------------------------------------

    /**
     * Adds every device of `userIds` to the context's group.
     *
     * @returns the devices that had no key package left and were therefore *not* added. They will
     *          never be able to read the context, so callers must surface them rather than treating
     *          a partial add as success.
     */
    async addMembers(
        contextId: string,
        isChannel: boolean,
        userIds: string[],
    ): Promise<UnreachableDeviceDto[]> {
        const keyHandle = this.mls.keyHandle();
        if (!keyHandle) throw new Error('MLS session is locked');

        const ownDeviceId = await this.deviceIdentity.deviceId();
        const tokens = await firstValueFrom(this.transport.consumeTokensForUsers(userIds));
        const invitees = tokens.deviceTokens.filter(t => t.deviceId !== ownDeviceId);

        if (invitees.length === 0) return tokens.unreachableDevices ?? [];

        const published = await this.publish(contextId, isChannel, async () => {
            const groupId = (await this.mls.getActiveGroupId(contextId))!;
            const out = await firstValueFrom(
                this.mls.addMembers(
                    groupId,
                    keyHandle,
                    invitees.map(t => t.token),
                ),
            );

            return {
                commit: out.commit,
                epoch: out.epoch,
                groupInfo: out.groupInfo,
                deviceWelcomes: invitees.map(t => ({
                    deviceId: t.deviceId,
                    userId: t.userId,
                    welcome: out.welcome!,
                })),
            };
        });

        if (!published) throw new Error('Could not add members - the group moved on twice');

        return tokens.unreachableDevices ?? [];
    }

    /** Removes members by leaf index. Their devices lose access from the next epoch onward. */
    async removeMembers(contextId: string, isChannel: boolean, leafIndices: number[]): Promise<void> {
        const keyHandle = this.mls.keyHandle();
        if (!keyHandle) throw new Error('MLS session is locked');
        if (leafIndices.length === 0) return;

        const published = await this.publish(contextId, isChannel, async () => {
            const groupId = (await this.mls.getActiveGroupId(contextId))!;
            const out = await firstValueFrom(this.mls.removeMembers(groupId, keyHandle, leafIndices));
            return {commit: out.commit, epoch: out.epoch, groupInfo: out.groupInfo, deviceWelcomes: []};
        });

        if (!published) throw new Error('Could not remove members - the group moved on twice');
    }

    /**
     * Leaves the context's group.
     *
     * MLS does not let a member commit their own removal, so this publishes a Remove *proposal* and
     * a remaining member turns it into a commit. Local state is dropped either way - this device
     * gives up access the moment it asks to leave, whether or not anyone ever commits it.
     */
    async leaveContext(contextId: string, isChannel: boolean): Promise<void> {
        const keyHandle = this.mls.keyHandle();
        if (!keyHandle) return;

        const generation = await this.mls.getKnownGeneration(contextId);
        if (generation === null) return;

        const groupId = await this.mls.getGroupId(contextId, generation);
        if (!groupId) return;

        const proposal = await firstValueFrom(this.mls.leaveGroup(groupId, keyHandle));

        // The proposal is not a commit and does not claim an epoch, so it cannot go through the
        // epoch-ordered publish path. It rides the commit channel because that is the only fanout
        // the group has; a member picks it up and commits it.
        //
        // `isProposal` is what stops it poisoning the epoch counter. Without the flag the server
        // advanced the group to an epoch no client ever reached, so every member's catch-up
        // re-fetched the same proposal forever and no commit was ever accepted again - the group
        // could never gain a member after anyone left it.
        const state = await firstValueFrom(this.transport.getState(contextId, isChannel));
        try {
            await firstValueFrom(
                this.transport.publishCommit(contextId, isChannel, {
                    epoch: (state.epoch ?? 0) + 1,
                    commit: proposal.commit,
                    senderDeviceId: await this.deviceIdentity.deviceId(),
                    generation,
                    welcomes: [],
                    isProposal: true,
                }),
            );
        } catch (err) {
            // Nothing to undo: local state is already gone, which is the part that matters for our
            // own forward secrecy. The group keeps listing us until someone removes us.
            console.error('Leave proposal could not be published', contextId, err);
        }

        await this.mls.clearActiveGeneration(contextId);
    }

    /**
     * Turns a departing member's Remove proposal into a commit.
     *
     * Called after processing a proposal: until someone does this, the group keeps encrypting to a
     * member who has already thrown away their keys.
     */
    async commitPendingProposals(contextId: string, isChannel: boolean): Promise<void> {
        const keyHandle = this.mls.keyHandle();
        if (!keyHandle) return;

        await this.publish(contextId, isChannel, async () => {
            const groupId = (await this.mls.getActiveGroupId(contextId))!;
            const out = await firstValueFrom(this.mls.commitPendingProposals(groupId, keyHandle));
            return {commit: out.commit, epoch: out.epoch, groupInfo: out.groupInfo, deviceWelcomes: []};
        });
    }

    // -------------------------------------------------------------------------
    // Encryption state
    // -------------------------------------------------------------------------

    /**
     * Reconciles this device's local view of a context with the server's.
     *
     * Encryption can be switched off and on again while we were away, which mints a whole new group.
     * Noticing that is what stops us encrypting to a group that no longer exists.
     */
    async refreshState(contextId: string, isChannel: boolean): Promise<MlsContextStateDto> {
        const state = await firstValueFrom(this.transport.getState(contextId, isChannel));
        const known = await this.mls.getKnownGeneration(contextId);

        if (!state.encrypted) {
            // Against the monotonic floor first, and the floor wins. Clearing the active
            // generation here is what used to make `getKnownGeneration` return null, which made
            // `mayPostCleartext` return true, which put the next composed message on the wire in
            // the clear - on nothing more than the server saying so. The floor is written when a
            // group is registered and is never deleted except by an explicit local disable, so a
            // context above it stays encrypted from this device's point of view no matter what the
            // wire claims. (§L.6, applied to encryption state.)
            const floor = await this.mls.getEncryptionFloor(contextId);
            if (floor !== null) {
                this.health.recordFailure(
                    contextId,
                    isChannel,
                    'downgraded',
                    `the server reports this context as unencrypted, but this device has held an ` +
                        `MLS group for it up to generation ${floor}`,
                );
                return state;
            }

            if (known !== null) await this.mls.clearActiveGeneration(contextId);
            return state;
        }

        const active = state.activeGeneration!;
        if (known === active) {
            await this.syncContext(contextId, isChannel);
            return state;
        }

        // A generation we have never joined. The Welcome for it may already be waiting; if it is
        // not, this device simply cannot read the context until someone adds it back.
        const existing = await this.mls.getGroupId(contextId, active);
        if (existing) {
            await this.mls.registerGroup(contextId, active, existing);
            await this.syncContext(contextId, isChannel);
        } else {
            await this.processPendingWelcomes();
        }

        return state;
    }

    // -------------------------------------------------------------------------

    /** Serializes `op` behind any in-flight work for the same context. */
    private serialized<T>(contextId: string, op: () => Promise<T>): Promise<T> {
        const prev = this.queues.get(contextId) ?? Promise.resolve();
        const task = prev.then(op, op);
        this.queues.set(
            contextId,
            task.then(
                () => undefined,
                () => undefined,
            ),
        );
        return task;
    }
}
