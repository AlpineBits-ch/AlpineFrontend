import {inject, Injectable, signal} from '@angular/core';
import {HttpClient, HttpErrorResponse} from '@angular/common/http';
import {firstValueFrom, Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {MlsService} from './mls.service';
import {MlsSyncService} from './mls-sync.service';
import {MlsHealthService} from './mls-health.service';
import {DeviceIdentityService} from './device-identity.service';
import {Base64} from '../dtos/mls.dto';

export interface MlsJoinRequestDto {
    id: string;
    contextId: string;
    channelId?: string | null;
    conversationId?: string | null;
    generation: number;
    requesterUserId: string;
    requesterDeviceId: string;
    /** SHA-256 of the key package that would be added. */
    keyPackageHash: string;
    /** The requester's long-lived identity fingerprint, for out-of-band comparison. */
    signatureKeyFingerprint: string;
    state: 'Pending' | 'Denied' | 'Fulfilled' | 'Cancelled';
    createdAt: string;
    expiresAt: string;
    requiredApprovals: number;
    approverUserIds: string[];
    /** The server's published verdict on whether a human has to tap approve (§J.1). */
    requiresManualApproval?: boolean;
}

export interface MlsJoinRequestApprovalResultDto {
    requestId: string;
    approvals: number;
    requiredApprovals: number;
    thresholdMet: boolean;
    /** Present only once the threshold is met - the bytes to add. */
    keyPackage?: Base64 | null;
    keyPackageHash: string;
    generation: number;
}

/** Why an approval did not result in an admission. */
export class JoinRequestVerificationError extends Error {
}

/**
 * What "Re-link device" was actually able to do.
 *
 * <p>The two states that used to be one are `recovered` and `requested`. Catching up on missed
 * commits and acquiring a leaf that was never in the group are different faults with disjoint
 * remedies, and only the first is something this device can do by itself.</p>
 */
export type MlsRelinkOutcome =
    /** This device holds a group for the context again - it was simply behind, or a Welcome landed. */
    | {state: 'recovered'}
    /** Nothing to join: the context is not encrypted and never has been on this device. */
    | {state: 'not-encrypted'}
    /** No leaf, and an admission request has just been submitted. */
    | {state: 'requested'; request: MlsJoinRequestDto}
    /** No leaf, and a request was already open - waiting on a member to approve it. */
    | {state: 'pending'; request: MlsJoinRequestDto}
    /** Nothing could be done, and the user is told why rather than left with a silent button. */
    | {state: 'failed'; message: string};

/** How the banner should render a {@link MlsRelinkOutcome}. */
export interface MlsRelinkStatus {
    tone: 'working' | 'ok' | 'pending' | 'failed';
    message: string;
}

/**
 * A context the launch-time §B sweep may ask to be admitted to.
 *
 * <p>`serverSaysEncrypted` decides only whether to *ask*. It is never allowed to decide that
 * something is plaintext - that direction belongs to the local encryption floor, which the sweep
 * consults precisely so a server answering "not encrypted" for a context this device has encrypted
 * does not quietly remove it from the candidate set.</p>
 */
export interface MlsAdmissionCandidate {
    contextId: string;
    isChannel: boolean;
    serverSaysEncrypted: boolean;
}

/** What one launch-time sweep did, for the log. */
export interface MlsSweepOutcome {
    /** Contexts the sweep did network work for. The rest were excluded by free local checks. */
    probed: number;
    /** Admission requests submitted. */
    requested: number;
    /** Contexts that already had this device's request open, and were left alone. */
    alreadyPending: number;
    /** Contexts that turned out to be readable after a catch-up. */
    recovered: number;
    failed: number;
    /** Eligible contexts left for the next launch because the per-launch cap was reached. */
    deferred: number;
}

/**
 * Turns an outcome into the sentence shown beside the button.
 *
 * <p>Exported rather than duplicated in each host: conversations and channels reached the same
 * dead end through two copies of `relinkDevice`, and a second copy of the wording is a second
 * place for it to go stale.</p>
 */
export function describeRelinkOutcome(outcome: MlsRelinkOutcome): MlsRelinkStatus {
    switch (outcome.state) {
        case 'recovered':
            return {tone: 'ok', message: 'This device is back in the group. Reload to read what it missed.'};
        case 'not-encrypted':
            return {tone: 'ok', message: 'This conversation is not encrypted, so there is nothing to join.'};
        case 'requested':
            return {
                tone: 'pending',
                message: 'Asked to be admitted. Someone already in the conversation has to approve '
                    + 'this device before it can read anything.',
            };
        case 'pending':
            return {
                tone: 'pending',
                message: 'This device has already asked to be admitted, and is waiting for someone '
                    + 'already in the conversation to approve it.',
            };
        case 'failed':
            return {tone: 'failed', message: `Re-linking failed. ${outcome.message}`};
    }
}

/**
 * The most specific thing that can honestly be said about a refused admission request.
 *
 * <p>Prefers the server's own message. The one that matters most is
 * <i>"'x' is not one of your registered devices"</i> - that is this device never having completed
 * registration, which is a different problem from not being admitted and needs to reach the user
 * as itself rather than as a generic failure.</p>
 *
 * <p>Exported because the review side needs the same treatment for the same reason: an approval
 * refused because the request has already expired, or because this device cannot be told apart
 * from the one asking, is actionable, and "something went wrong" is not.</p>
 */
export function describeRequestFailure(err: unknown): string {
    if (err instanceof HttpErrorResponse) {
        const body = err.error as {detail?: string; title?: string; message?: string} | string | null;
        const served = typeof body === 'string' ? body : body?.detail ?? body?.message ?? body?.title;
        if (served) return served;
        return `The server refused the request (HTTP ${err.status}).`;
    }
    return err instanceof Error ? err.message : String(err);
}

/**
 * Getting into, and letting people into, an encrypted context.
 *
 * <p>The server cannot admit anyone - it holds no group keys, so only a current member can produce
 * an Add commit. Admission is therefore a request that members review, and the approval that meets
 * the threshold is what makes that member's client mint the Welcome.</p>
 *
 * <p><b>Both context kinds.</b> Every route here used to be hard-coded to `/channels/...`, so a
 * device left out of a *conversation* had no way to ask at all - the one recovery affordance it was
 * offered called {@link MlsSyncService.refreshState}, which catches a device up on commits and
 * cannot add a leaf that was never in the group. The routes are identical in shape (contract §B),
 * so the only thing that ever needed to change was the base path.</p>
 */
@Injectable({providedIn: 'root'})
export class MlsJoinRequestService {
    /**
     * How many contexts one launch-time sweep will do network work for.
     *
     * <p>A cap rather than a spread: the eligible set is whatever this device is locked out of, the
     * excluded contexts cost nothing to skip, and anything past the cap is simply picked up by the
     * next launch or by the user opening it. Spreading over time would need a scheduler and would
     * still be firing requests minutes after launch, which is harder to reason about and no kinder
     * to the server. Within the cap, a context that already has this device's request open is not
     * asked again - see {@link relink}.</p>
     */
    static readonly MAX_CONTEXTS_PER_SWEEP = 10;

    private http = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);
    private mls = inject(MlsService);
    private sync = inject(MlsSyncService);
    private health = inject(MlsHealthService);
    private deviceIdentity = inject(DeviceIdentityService);

    /**
     * The last re-link outcome per context, so the banner can render it wherever it came from.
     *
     * <p>Owned here rather than by each host because the launch sweep asks on behalf of contexts
     * nobody is looking at. Without a shared place to put the answer, a sweep that submitted an
     * admission request would be exactly as silent as the exclusion it is fixing - the user would
     * open the conversation days later and see only the same banner.</p>
     */
    private readonly _status = signal<Record<string, MlsRelinkStatus>>({});

    /** Reactive: read it from a `computed` in the component that renders the banner. */
    statusOf(contextId: string): MlsRelinkStatus | null {
        return this._status()[contextId] ?? null;
    }

    private setStatus(contextId: string, status: MlsRelinkStatus): void {
        this._status.update(current => ({...current, [contextId]: status}));
    }

    private base(contextId: string, isChannel: boolean): string {
        const collection = isChannel ? 'channels' : 'conversations';
        return `${this.apiConfig.baseUrl()}/api/v1/messaging/${collection}/`
            + `${encodeURIComponent(contextId)}/mls/join-requests`;
    }

    list(contextId: string, isChannel: boolean): Observable<MlsJoinRequestDto[]> {
        return this.http.get<MlsJoinRequestDto[]>(this.base(contextId, isChannel));
    }

    deny(contextId: string, isChannel: boolean, requestId: string): Observable<void> {
        return this.http.post<void>(`${this.base(contextId, isChannel)}/${requestId}/deny`, null);
    }

    cancel(contextId: string, isChannel: boolean, requestId: string): Observable<void> {
        return this.http.delete<void>(`${this.base(contextId, isChannel)}/${requestId}`);
    }

    /**
     * Asks to be let into an encrypted context.
     *
     * Mints a key package specifically for this request and submits it, rather than pointing at the
     * pool on the server: reviewers approve exact bytes, and bytes nobody else can hand out cannot
     * be swapped between approval and add.
     */
    async requestAccess(contextId: string, isChannel: boolean): Promise<MlsJoinRequestDto> {
        const keyHandle = this.mls.keyHandle();
        if (!keyHandle) throw new Error('MLS session is locked');

        const [keyPackage] = await firstValueFrom(this.mls.generateAdditionalKeyPackages(keyHandle, 1));
        if (!keyPackage) throw new Error('Could not generate a key package for the request');

        const info = await firstValueFrom(this.mls.inspectKeyPackage(keyPackage.keyPackage));

        return firstValueFrom(this.http.post<MlsJoinRequestDto>(this.base(contextId, isChannel), {
            keyPackage: keyPackage.keyPackage,
            deviceId: await this.deviceIdentity.deviceId(),
            signatureKeyFingerprint: info.signatureKeyFingerprint,
        }));
    }

    /**
     * This device's own identity fingerprint, so its owner can read it out to a reviewer.
     *
     * Derived from the loaded signing key, not from a freshly minted key package. The earlier
     * version minted one per call and discarded it, which on a screen that re-renders would have
     * silently drained a finite supply until the device could not be added to any group at all.
     */
    async ownFingerprint(): Promise<string | null> {
        const keyHandle = this.mls.keyHandle();
        if (!keyHandle) return null;

        return firstValueFrom(this.mls.ownFingerprint(keyHandle));
    }

    /**
     * This device's own outstanding request for a context, if it has one.
     *
     * Found by listing: a locked-out member can still see the context, so they can read the queue
     * their own request is sitting in.
     */
    async myPendingRequest(contextId: string, isChannel: boolean): Promise<MlsJoinRequestDto | null> {
        const deviceId = await this.deviceIdentity.deviceId();
        const requests = await firstValueFrom(this.list(contextId, isChannel));
        return requests.find(r => r.requesterDeviceId === deviceId) ?? null;
    }

    /**
     * Everything "Re-link device" can legitimately mean, in the order that costs least.
     *
     * <p><b>The button used to be one call to {@link MlsSyncService.refreshState} with its failure
     * going to `console.error`.</b> That is the right remedy for exactly one of the states it is
     * offered in - being behind on commits - and a no-op for the one the banner most often names:
     * this device holding no leaf at all. In that case `refreshState` succeeded trivially, nothing
     * changed, and nothing said so, so the user pressed a button that appeared to work and did not.
     * A leaf can only be added by a current member, so the honest second step is to ask one.</p>
     *
     * <p>Nothing here clears the health entry on its own. Recovery is recorded by the code that
     * actually joins or decrypts something; a re-link that changed nothing re-records
     * `not-admitted`, so the banner stays up and stays accurate.</p>
     */
    async relink(contextId: string, isChannel: boolean): Promise<MlsRelinkOutcome> {
        this.setStatus(contextId, {tone: 'working', message: 'Checking this device...'});
        const outcome = await this.resolveRelink(contextId, isChannel);
        this.setStatus(contextId, describeRelinkOutcome(outcome));
        return outcome;
    }

    private async resolveRelink(contextId: string, isChannel: boolean): Promise<MlsRelinkOutcome> {
        // Cheapest first, and it is the common case: catch up on missed commits, and join from a
        // Welcome that is already waiting. Deliberately not a new signing key - that orphans this
        // device from every group it is in, and is never the right response to "I could not read".
        let encrypted: boolean;
        try {
            encrypted = (await this.sync.refreshState(contextId, isChannel)).encrypted;
        } catch (err) {
            return {state: 'failed', message: describeRequestFailure(err)};
        }

        // `refreshState` has already tried every Welcome addressed to this device, so holding a
        // group now means the re-link genuinely worked.
        if (await this.mls.getActiveGroupId(contextId)) return {state: 'recovered'};

        // The floor outranks the server's field: a context this device has ever encrypted stays
        // encrypted here (§L.6), so "not encrypted" is only believable below it.
        if (!encrypted && await this.mls.getEncryptionFloor(contextId) === null) {
            return {state: 'not-encrypted'};
        }

        // No leaf, and no Welcome that would give us one. Correct the reason before asking, so the
        // banner stops claiming a decrypt problem when the real state is exclusion.
        this.health.recordFailure(
            contextId, isChannel, 'not-admitted',
            'this device holds no MLS group for the context and no Welcome is waiting for it');

        try {
            const existing = await this.myPendingRequest(contextId, isChannel);
            if (existing && existing.state === 'Pending') return {state: 'pending', request: existing};

            return {state: 'requested', request: await this.requestAccess(contextId, isChannel)};
        } catch (err) {
            return {state: 'failed', message: describeRequestFailure(err)};
        }
    }

    /**
     * Contract §B discovery, at launch: asks to be admitted to everything this device should be
     * able to read and holds no group for.
     *
     * <p><b>Why this exists rather than leaving it to the banner.</b> Without it, exclusion is
     * discovered one conversation at a time, by the user opening each one and reading a notice -
     * which is no use at all to somebody who does not know which conversations they are missing
     * from, and no use whatsoever for the ones they never open. A device stranded by a bug stays
     * stranded until it is noticed. That is not self-healing; this is.</p>
     *
     * <p><b>Cheap when nothing is wrong.</b> Every exclusion is decided by
     * {@link shouldProbe} first, and all three of its checks read local state. A healthy device
     * therefore does the whole sweep with zero requests.</p>
     *
     * <p>Reuses {@link relink} per context rather than reimplementing the ceremony, so the
     * dedupe against an outstanding request, the failure wording and the status the banner reads
     * are the same ones the button produces.</p>
     */
    async sweepForAdmission(candidates: MlsAdmissionCandidate[]): Promise<MlsSweepOutcome> {
        const outcome: MlsSweepOutcome = {
            probed: 0, requested: 0, alreadyPending: 0, recovered: 0, failed: 0, deferred: 0,
        };

        // No signing key loaded means no key package to offer and nothing to join with. Asking
        // would fail on every candidate and leave a wall of failures behind it.
        if (!this.mls.keyHandle()) return outcome;

        for (const candidate of candidates) {
            if (!(await this.shouldProbe(candidate))) continue;

            if (outcome.probed >= MlsJoinRequestService.MAX_CONTEXTS_PER_SWEEP) {
                outcome.deferred++;
                continue;
            }

            outcome.probed++;

            // Sequential on purpose. These are recovery requests for a device that is already
            // locked out; a burst of them in parallel is exactly the shape the server's consume and
            // join-request limits exist to refuse, and arriving faster helps nobody.
            const result = await this.relink(candidate.contextId, candidate.isChannel);

            switch (result.state) {
                case 'requested':
                    outcome.requested++;
                    break;
                case 'pending':
                    outcome.alreadyPending++;
                    break;
                case 'recovered':
                    outcome.recovered++;
                    break;
                case 'failed':
                    outcome.failed++;
                    break;
                case 'not-encrypted':
                    break;
            }
        }

        return outcome;
    }

    /**
     * Whether a candidate is worth a network round trip. Every check here is local.
     *
     * @returns false for the three cases where asking would be wrong, not merely wasteful.
     */
    private async shouldProbe(candidate: MlsAdmissionCandidate): Promise<boolean> {
        // Already in the group. The overwhelmingly common answer, and it costs nothing.
        if (await this.mls.getActiveGroupId(candidate.contextId)) return false;

        // Nothing to join. The floor outranks the wire (§L.6), so a context this device has held a
        // group for stays a candidate even when the server now calls it plaintext - that claim is
        // the one thing the floor exists to disbelieve.
        if (!candidate.serverSaysEncrypted
            && await this.mls.getEncryptionFloor(candidate.contextId) === null) {
            return false;
        }

        // Someone removed this device on purpose. §E9 says surface it and offer a re-link; a sweep
        // that asked to be let back in on every launch would turn a deliberate removal into a
        // recurring approval prompt for the person who performed it, which is both spam and a way
        // to wear down a decision that was made once.
        return this.health.healthOf(candidate.contextId)?.reason !== 'removed';
    }

    /**
     * Vouches for a request, and admits the device when that completes the threshold.
     *
     * <p>Before adding anything this re-derives the fingerprint and hash from the bytes the server
     * handed back and checks them against what was reviewed. Skipping that would make the whole
     * review ceremonial: a server that substituted its own key package between approval and add
     * would have its key silently welcomed into the group.</p>
     *
     * @returns whether the device was actually admitted by this call.
     */
    async approve(contextId: string, isChannel: boolean, request: MlsJoinRequestDto): Promise<boolean> {
        const result = await firstValueFrom(
            this.http.post<MlsJoinRequestApprovalResultDto>(
                `${this.base(contextId, isChannel)}/${request.id}/approve`, null),
        );

        if (!result.thresholdMet) return false;
        if (!result.keyPackage) {
            throw new JoinRequestVerificationError(
                'The server reported the threshold met but returned no key package.');
        }

        const info = await firstValueFrom(this.mls.inspectKeyPackage(result.keyPackage));

        if (info.keyPackageHash !== request.keyPackageHash) {
            throw new JoinRequestVerificationError(
                'The key package does not match the one that was reviewed. Nothing was added.');
        }
        if (info.signatureKeyFingerprint !== request.signatureKeyFingerprint) {
            throw new JoinRequestVerificationError(
                'The identity key does not match the one that was reviewed. Nothing was added.');
        }
        if (info.identity !== request.requesterUserId) {
            throw new JoinRequestVerificationError(
                'The key package claims a different user than the request. Nothing was added.');
        }

        const keyHandle = this.mls.keyHandle();
        if (!keyHandle) throw new Error('MLS session is locked');

        const admitted = await this.sync.publish(contextId, isChannel, async () => {
            const groupId = (await this.mls.getActiveGroupId(contextId))!;
            const out = await firstValueFrom(
                this.mls.addMembers(groupId, keyHandle, [result.keyPackage!]),
            );
            return {
                commit: out.commit,
                epoch: out.epoch,
                groupInfo: out.groupInfo,
                deviceWelcomes: [{
                    deviceId: request.requesterDeviceId,
                    userId: request.requesterUserId,
                    welcome: out.welcome!,
                }],
                fulfilledJoinRequestIds: [request.id],
            };
        });

        if (!admitted) {
            throw new Error('The group moved on while admitting; the request is still open.');
        }

        return true;
    }
}
