import {computed, inject, Injectable, signal} from '@angular/core';

import {MlsService} from '../../../../../services/mls.service';
import {MlsSyncService} from '../../../../../services/mls-sync.service';
import {MlsJoinRequestService} from '../../../../../services/mls-join-request.service';
import {ChannelEncryptionState} from '../channel-utils';

/**
 * Where this device stands with one channel's encryption. Component-scoped: the host points it at a
 * channel with {@link open} and reads the rest.
 */
@Injectable()
export class ChannelEncryptionService {
    private readonly mls = inject(MlsService);
    private readonly mlsSync = inject(MlsSyncService);
    private readonly joinRequests = inject(MlsJoinRequestService);

    /** The channel {@link open} was last called with. */
    readonly channelId = signal('');
    /** Three states, not two: 'locked-out' means encrypted but this device is not in the group. */
    readonly state = signal<ChannelEncryptionState>('plain');
    readonly isLockedOut = computed(() => this.state() === 'locked-out');
    /** What the last re-link attempt for this channel achieved, as the banner should render it. */
    readonly relinkStatus = computed(() => this.joinRequests.statusOf(this.channelId()));

    /** Points at a channel and works out which of the states it is in. */
    async open(channelId: string): Promise<void> {
        this.channelId.set(channelId);
        await this.resolve(channelId);
    }

    /** Tries to get this device readable again, from the banner; {@link MlsJoinRequestService.relink} does the retry and, if needed, asks a member to admit this device. Deliberately never mints a new signing key: that would orphan the device from every group it belongs to. */
    async relink(): Promise<void> {
        const channelId = this.channelId();
        await this.joinRequests.relink(channelId, true);

        // Re-derive the composer's view from what the re-link actually left behind, rather than
        // from a second refresh: `relink` has already reconciled state and, where it could, asked
        // to be admitted.
        await this.resolve(channelId);
    }

    private async resolve(channelId: string): Promise<void> {
        try {
            const state = await this.mlsSync.refreshState(channelId, true);

            if (!state.encrypted) {
                // Never 'plain' above the floor: this device having held a group for the channel is local proof that state.encrypted being false is stale or wrong, not a real downgrade.
                if ((await this.mls.getEncryptionFloor(channelId)) !== null) {
                    this.state.set('downgraded');
                    return;
                }
                this.state.set('plain');
                return;
            }

            // refreshState already tried to join from any waiting Welcome, so holding no group here means we genuinely have not been admitted.
            const groupId = await this.mls.getActiveGroupId(channelId);
            this.state.set(groupId ? 'joined' : 'locked-out');
        } catch (err) {
            console.error('Could not resolve channel encryption state', channelId, err);
            // Deliberately not 'plain': guessing plaintext on a failed lookup is how ciphertext ends up sent in the clear, so this leaves the previous state instead.
        }
    }
}
