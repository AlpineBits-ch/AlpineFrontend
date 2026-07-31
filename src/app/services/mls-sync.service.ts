import {inject, Injectable} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {firstValueFrom, Subject} from 'rxjs';
import {MlsService} from './mls.service';
import {MlsTransportService} from './mls-transport.service';
import {DeviceIdentityService} from './device-identity.service';
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

    private readonly mls = inject(MlsService);
    private readonly transport = inject(MlsTransportService);
    private readonly deviceIdentity = inject(DeviceIdentityService);

    /**
     * One in-flight operation per context.
     *
     * A realtime nudge and a launch-time sweep routinely target the same context at once; letting
     * both walk the commit list would apply the same commit twice, and the second application
     * fails and looks like corruption.
     */
    private readonly queues = new Map<string, Promise<unknown>>();

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

        if (joined.length > 0) await firstValueFrom(this.transport.ackWelcomes(joined));
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
            return true;
        } catch (err) {
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
    syncContext(contextId: string, isChannel: boolean): Promise<void> {
        return this.serialized(contextId, () => this.syncContextInner(contextId, isChannel));
    }

    private async syncContextInner(contextId: string, isChannel: boolean): Promise<void> {
        const generation = await this.mls.getKnownGeneration(contextId);
        if (generation === null) return;

        const groupId = await this.mls.getGroupId(contextId, generation);
        if (!groupId) return;

        for (; ;) {
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
            for (const commit of commits) {
                // Strictly sequential. A gap means the page started above our epoch, which should be
                // impossible - stopping is safer than applying out of order.
                if (commit.epoch !== epoch + applied + 1) break;

                const removed = await this.applyCommit(contextId, isChannel, groupId, commit.commit);
                applied++;
                if (removed) return;
            }

            if (applied === 0) return;
        }
    }

    /** @returns true when the commit removed *this* device from the group. */
    private async applyCommit(
        contextId: string,
        isChannel: boolean,
        groupId: string,
        commitB64: string,
    ): Promise<boolean> {
        const processed = await firstValueFrom(this.mls.processMessage(groupId, commitB64));

        if (processed.kind !== 'commit') return false;

        if (processed.selfRemoved) {
            // We are out. The group's keys are useless from here, and holding them would only let a
            // stale UI claim it can still read the context.
            await this.mls.clearActiveGeneration(contextId);
            try {
                await firstValueFrom(this.mls.deleteGroup(groupId));
            } catch (err) {
                console.error('Failed to delete group after removal', contextId, err);
            }
            this.contextChanged.next({contextId, isChannel, selfRemoved: true});
            return true;
        }

        if (processed.addedMembers.length > 0 || processed.removedLeafIndices.length > 0) {
            this.contextChanged.next({contextId, isChannel, selfRemoved: false});
        }

        return false;
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
        };

        try {
            dto.groupInfo = await firstValueFrom(
                this.mls.exportGroupInfo(groupId, this.mls.keyHandle()!),
            );
        } catch {
            // A refreshed GroupInfo only helps devices that fall too far behind to replay. Losing
            // it is a degraded recovery path, not a reason to abandon the commit.
        }

        try {
            await firstValueFrom(this.transport.publishCommit(contextId, isChannel, dto));
            await firstValueFrom(this.mls.mergePendingCommit(groupId));
            return true;
        } catch (err) {
            await this.discardStagedCommit(groupId);
            if (!this.isEpochConflict(err)) throw err;
            return false;
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
                this.mls.addMembers(groupId, keyHandle, invitees.map(t => t.token)),
            );

            return {
                commit: out.commit,
                epoch: out.epoch,
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
            return {commit: out.commit, epoch: out.epoch, deviceWelcomes: []};
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
        const state = await firstValueFrom(this.transport.getState(contextId, isChannel));
        try {
            await firstValueFrom(this.transport.publishCommit(contextId, isChannel, {
                epoch: (state.epoch ?? 0) + 1,
                commit: proposal.commit,
                senderDeviceId: await this.deviceIdentity.deviceId(),
                generation,
                welcomes: [],
            }));
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
            return {commit: out.commit, epoch: out.epoch, deviceWelcomes: []};
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
        this.queues.set(contextId, task.then(() => undefined, () => undefined));
        return task;
    }
}
