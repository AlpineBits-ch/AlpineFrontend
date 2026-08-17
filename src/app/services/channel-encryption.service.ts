import {inject, Injectable} from '@angular/core';
import {firstValueFrom} from 'rxjs';
import {MlsService} from './mls.service';
import {MlsSyncService} from './mls-sync.service';
import {MlsTransportService} from './mls-transport.service';
import {DeviceWelcomeDto, MlsToggleResultDto, UnreachableDeviceDto} from '../dtos/mls.dto';

export interface EnableChannelEncryptionResult {
    generation: number;
    /**
     * Devices that had no key package left and were therefore not added. They cannot read anything
     * sent from now on, so the caller has to say so rather than reporting a clean success.
     */
    unreachableDevices: UnreachableDeviceDto[];
}

export interface DisableChannelEncryptionResult {
    /**
     * Messages sent under this generation stay ciphertext. Nothing is decrypted or rewritten, so
     * anyone without that group's keys - including future members - cannot read that stretch.
     */
    terminatedGeneration: number | null;
    alreadyPlain: boolean;
}

/**
 * Turning a guild channel's end-to-end encryption on and off.
 *
 * Enabling builds a fresh MLS group over whoever can currently see the channel. Disabling
 * terminates it. Doing both repeatedly is expected and safe - each enable mints a new generation
 * rather than resuming the last one, because resuming would hand the old traffic to whoever joined
 * while it was off.
 */
@Injectable({providedIn: 'root'})
export class ChannelEncryptionService {
    private readonly mls = inject(MlsService);
    private readonly sync = inject(MlsSyncService);
    private readonly transport = inject(MlsTransportService);

    /**
     * Turns encryption on, adding every device of `memberUserIds` to the new group.
     *
     * Plaintext already in the channel is untouched and stays readable - this marks a boundary in
     * the channel's timeline, it does not convert anything.
     */
    async enable(channelId: string, memberUserIds: string[]): Promise<EnableChannelEncryptionResult> {
        const keyHandle = this.mls.keyHandle();
        if (!keyHandle) throw new Error('MLS session is locked');

        const ownDeviceId = await this.mls.getOrCreateDeviceIdentifier();
        const tokens = await firstValueFrom(this.transport.consumeTokensForUsers(memberUserIds));
        const invitees = tokens.deviceTokens.filter(t => t.deviceId !== ownDeviceId);

        const groupIdBytes = crypto.getRandomValues(new Uint8Array(16));
        const groupIdB64 = btoa(String.fromCharCode(...groupIdBytes));

        await firstValueFrom(this.mls.createGroup(groupIdB64, keyHandle));

        try {
            let epoch = 0;
            let welcomes: DeviceWelcomeDto[] = [];
            let groupInfo: string | undefined;

            if (invitees.length > 0) {
                const commitOut = await firstValueFrom(
                    this.mls.addMembers(groupIdB64, keyHandle, invitees.map(t => t.token)),
                );
                // Merged straight away: this group exists nowhere but here until the enable call
                // lands, so there is no other committer to lose an epoch race against.
                await firstValueFrom(this.mls.mergePendingCommit(groupIdB64));

                epoch = commitOut.epoch;
                welcomes = invitees.map(t => ({
                    deviceId: t.deviceId,
                    userId: t.userId,
                    welcome: commitOut.welcome!,
                }));
                // The commit's own GroupInfo describes the epoch it establishes. Exporting one
                // works here only because the merge above has already happened; taking it from the
                // commit keeps this identical to the publish path, where the merge deliberately
                // comes later and an export would be an epoch stale.
                groupInfo = commitOut.groupInfo
                    ?? await firstValueFrom(this.mls.exportGroupInfo(groupIdB64, keyHandle));
            }

            const result: MlsToggleResultDto = await firstValueFrom(
                this.transport.enableChannelEncryption(channelId, {
                    mlsGroupId: groupIdB64,
                    epoch,
                    mlsGroupInfo: groupInfo,
                    welcomes,
                }),
            );

            const generation = result.generation!;
            await this.mls.registerGroup(channelId, generation, groupIdB64);

            return {generation, unreachableDevices: tokens.unreachableDevices ?? []};
        } catch (err) {
            // The server did not take the group, so nothing else will ever reference it. Leaving it
            // behind would have this device holding keys for an era that never existed, and the
            // next attempt would build a second group for the same channel.
            await firstValueFrom(this.mls.deleteGroup(groupIdB64)).catch(() => undefined);
            throw err;
        }
    }

    /**
     * Turns encryption off.
     *
     * The local group is deliberately *not* deleted: the messages it encrypted are still in the
     * channel, and this device is one of the few that can still read them. Only the "this context
     * is currently encrypted" marker is cleared.
     */
    async disable(channelId: string): Promise<DisableChannelEncryptionResult> {
        const result = await firstValueFrom(this.transport.disableChannelEncryption(channelId));

        await this.mls.clearActiveGeneration(channelId);

        return {
            terminatedGeneration: result.terminatedGeneration ?? null,
            alreadyPlain: result.alreadyInRequestedState ?? false,
        };
    }

    /** Whether this channel is encrypted right now, and under which generation. */
    async state(channelId: string) {
        return this.sync.refreshState(channelId, true);
    }
}
