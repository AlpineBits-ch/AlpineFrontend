import {inject, Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {firstValueFrom, Observable} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {MlsService} from './mls.service';
import {MlsSyncService} from './mls-sync.service';
import {DeviceIdentityService} from './device-identity.service';
import {UserService} from './user.service';
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
 * Getting into, and letting people into, an encrypted context.
 *
 * <p>The server cannot admit anyone - it holds no group keys, so only a current member can produce
 * an Add commit. Admission is therefore a request that members review, and the approval that meets
 * the threshold is what makes that member's client mint the Welcome.</p>
 */
@Injectable({providedIn: 'root'})
export class MlsJoinRequestService {
    private http = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);
    private mls = inject(MlsService);
    private sync = inject(MlsSyncService);
    private deviceIdentity = inject(DeviceIdentityService);
    private userService = inject(UserService);

    private base(channelId: string): string {
        return `${this.apiConfig.baseUrl()}/api/v1/messaging/channels/${encodeURIComponent(channelId)}/mls/join-requests`;
    }

    list(channelId: string): Observable<MlsJoinRequestDto[]> {
        return this.http.get<MlsJoinRequestDto[]>(this.base(channelId));
    }

    deny(channelId: string, requestId: string): Observable<void> {
        return this.http.post<void>(`${this.base(channelId)}/${requestId}/deny`, null);
    }

    cancel(channelId: string, requestId: string): Observable<void> {
        return this.http.delete<void>(`${this.base(channelId)}/${requestId}`);
    }

    /**
     * Asks to be let into an encrypted channel.
     *
     * Mints a key package specifically for this request and submits it, rather than pointing at the
     * pool on the server: reviewers approve exact bytes, and bytes nobody else can hand out cannot
     * be swapped between approval and add.
     */
    async requestAccess(channelId: string): Promise<MlsJoinRequestDto> {
        const keyHandle = this.mls.keyHandle();
        if (!keyHandle) throw new Error('MLS session is locked');

        const [keyPackage] = await firstValueFrom(this.mls.generateAdditionalKeyPackages(keyHandle, 1));
        if (!keyPackage) throw new Error('Could not generate a key package for the request');

        const info = await firstValueFrom(this.mls.inspectKeyPackage(keyPackage.keyPackage));

        return firstValueFrom(this.http.post<MlsJoinRequestDto>(this.base(channelId), {
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
     * This device's own outstanding request for a channel, if it has one.
     *
     * Found by listing: a locked-out member can still see the channel, so they can read the queue
     * their own request is sitting in.
     */
    async myPendingRequest(channelId: string): Promise<MlsJoinRequestDto | null> {
        const deviceId = await this.deviceIdentity.deviceId();
        const requests = await firstValueFrom(this.list(channelId));
        return requests.find(r => r.requesterDeviceId === deviceId) ?? null;
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
    async approve(channelId: string, request: MlsJoinRequestDto): Promise<boolean> {
        const result = await firstValueFrom(
            this.http.post<MlsJoinRequestApprovalResultDto>(
                `${this.base(channelId)}/${request.id}/approve`, null),
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

        const admitted = await this.sync.publish(channelId, true, async () => {
            const groupId = (await this.mls.getActiveGroupId(channelId))!;
            const out = await firstValueFrom(
                this.mls.addMembers(groupId, keyHandle, [result.keyPackage!]),
            );
            return {
                commit: out.commit,
                epoch: out.epoch,
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
