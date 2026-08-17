import {Component, computed, inject, model, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {NgClass} from '@angular/common';
import {firstValueFrom} from 'rxjs';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Avatar} from 'primeng/avatar';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {PrimeTemplate} from 'primeng/api';
import {RelationshipStore} from '../../../../../stores/relationship.store';
import {ConversationService} from '../../../../../services/conversation.service';
import {MlsService} from '../../../../../services/mls.service';
import {MlsTransportService} from '../../../../../services/mls-transport.service';
import {ConversationStore} from '../../../../../stores/conversation.store';
import {NavigationService} from '../../../navigation.service';
import {ProfileService} from '../../../../../services/profile.service';
import {ConversationEncryption} from '../../../../../enums/conversation-encryption.enum';
import {DeviceWelcomeDto} from '../../../../../dtos/request/create-conversation.dto';
import {TranslateModule} from '@ngx-translate/core';

@Component({
    selector: 'app-new-conversation-dialog',
    imports: [Dialog, Button, InputText, Avatar, FormsModule, PrimeTemplate, NgClass, ToggleSwitch, TranslateModule],
    templateUrl: './new-conversation-dialog.component.html',
})
export class NewConversationDialogComponent {
    readonly visible = model.required<boolean>();
    private relationshipStore = inject(RelationshipStore);
    readonly friends = computed(() => this.relationshipStore.friends().map(r => r.other));
    readonly search = signal('');
    readonly selectedIds = signal(new Set<string>());
    readonly groupName = signal('');
    readonly encrypted = signal(false);
    readonly creating = signal(false);
    /** Device names that cannot be added for lack of key packages. */
    readonly unreachableDevices = signal<string[]>([]);
    /** Set when the user has seen the unreachable list and chosen to create anyway. */
    readonly acceptedUnreachable = signal(false);
    /**
     * Coverage problems the server reported *after* the conversation existed - devices it could not
     * reach, and devices admitted on a reusable last-resort key package.
     */
    readonly createdWarning = signal<{ devices: string[]; lastResortCount: number } | null>(null);
    readonly filteredFriends = computed(() => {
        const q = this.search().toLowerCase();
        return q
            ? this.friends().filter(f => f.userName.toLowerCase().includes(q))
            : this.friends();
    });
    readonly selectedFriends = computed(() =>
        this.friends().filter(f => this.selectedIds().has(f.userId))
    );
    readonly isGroup = computed(() => this.selectedIds().size >= 2);
    readonly canCreate = computed(() => this.selectedIds().size >= 1 && !this.creating());
    private conversationService = inject(ConversationService);
    private mlsService = inject(MlsService);
    private mlsTransport = inject(MlsTransportService);
    private conversationStore = inject(ConversationStore);
    private navService = inject(NavigationService);
    private profileService = inject(ProfileService);

    constructor() {
        this.relationshipStore.load();
    }

    toggleFriend(userId: string): void {
        this.selectedIds.update(prev => {
            const next = new Set(prev);
            next.has(userId) ? next.delete(userId) : next.add(userId);
            return next;
        });
    }

    isSelected(userId: string): boolean {
        return this.selectedIds().has(userId);
    }

    create(): void {
        if (!this.canCreate()) return;
        this.creating.set(true);

        const members = Array.from(this.selectedIds()).map(userId => ({userId}));
        const name = this.isGroup() && this.groupName().trim() ? this.groupName().trim() : undefined;

        if (this.encrypted()) {
            this.createEncrypted(members, name);
        } else {
            this.conversationService
                .createConversation({name, members, encryption: ConversationEncryption.Plain, deviceWelcomes: []})
                .subscribe({
                    next: conv => {
                        this.conversationStore.addConversation(conv);
                        this.navService.openConversation(conv);
                        this.close();
                    },
                    error: () => this.creating.set(false),
                });
        }
    }

    close(): void {
        this.visible.set(false);
        this.selectedIds.set(new Set());
        this.groupName.set('');
        this.search.set('');
        this.encrypted.set(false);
        this.creating.set(false);
        this.unreachableDevices.set([]);
        this.acceptedUnreachable.set(false);
        this.createdWarning.set(null);
    }

    /** "Create anyway" - those devices stay unable to read the conversation, and the user knows. */
    createWithoutUnreachableDevices(): void {
        this.acceptedUnreachable.set(true);
        this.unreachableDevices.set([]);
        this.create();
    }

    /** "Cancel" from the unreachable-devices prompt. */
    cancelUnreachable(): void {
        this.unreachableDevices.set([]);
        this.acceptedUnreachable.set(false);
        this.creating.set(false);
    }

    private createEncrypted(members: { userId: string }[], name: string | undefined): void {
        const ownId = this.profileService.ownProfile()?.userId;
        const keyHandle = this.mlsService.keyHandle();

        if (!ownId || !keyHandle) {
            this.creating.set(false);
            return;
        }

        void this.buildAndCreate(members, name, ownId, keyHandle);
    }

    /** Builds the MLS group locally, then creates the conversation carrying it. */
    private async buildAndCreate(
        members: { userId: string }[],
        name: string | undefined,
        ownId: string,
        keyHandle: string,
    ): Promise<void> {
        const groupIdBytes = crypto.getRandomValues(new Uint8Array(16));
        const groupIdB64 = btoa(String.fromCharCode(...groupIdBytes));

        try {
            const ownDeviceId = await this.mlsService.getOrCreateDeviceIdentifier();
            const tokens = await firstValueFrom(
                this.mlsTransport.consumeTokensForUsers([ownId, ...Array.from(this.selectedIds())]),
            );
            const invitees = tokens.deviceTokens.filter(t => t.deviceId !== ownDeviceId);

            await firstValueFrom(this.mlsService.createGroup(groupIdB64, keyHandle));

            let epoch = 0;
            let deviceWelcomes: DeviceWelcomeDto[] = [];
            let mlsGroupInfo: string | undefined;

            // Devices with no key package left cannot be added, and nothing later will fix that:
            // they will never be able to read a word of this conversation. Creating anyway used to
            // happen silently, with the names shown afterwards as a footnote - so the person who
            // could not read it found out when a reply never came.
            const unreachable = tokens.unreachableDevices ?? [];
            if (unreachable.length > 0 && !this.acceptedUnreachable()) {
                this.unreachableDevices.set(unreachable.map(d => d.deviceName));
                await firstValueFrom(this.mlsService.deleteGroup(groupIdB64)).catch(() => undefined);
                this.creating.set(false);
                return;
            }

            if (invitees.length > 0) {
                const commitOut = await firstValueFrom(
                    this.mlsService.addMembers(groupIdB64, keyHandle, invitees.map(t => t.token)),
                );
                await firstValueFrom(this.mlsService.mergePendingCommit(groupIdB64));

                epoch = commitOut.epoch;
                deviceWelcomes = invitees.map(t => ({
                    deviceId: t.deviceId,
                    userId: t.userId,
                    welcome: commitOut.welcome!,
                }));
                // The commit's own GroupInfo, which describes the epoch it establishes. Exporting
                // one separately works here only because the merge above has already happened -
                // taking it from the commit keeps this path identical to the publish path, where
                // the merge deliberately comes later and an export would be an epoch stale.
                mlsGroupInfo = commitOut.groupInfo
                    ?? await firstValueFrom(this.mlsService.exportGroupInfo(groupIdB64, keyHandle));
            }

            const conv = await firstValueFrom(this.conversationService.createConversation({
                name,
                members,
                encryption: ConversationEncryption.Encrypted,
                deviceWelcomes,
                mlsGroupId: groupIdB64,
                mlsEpoch: epoch,
                mlsGroupInfo,
                // Explicit, per contract §E7: the server is permissive during the transition, so
                // it would create either way. Sending the flag records that a human was shown the
                // list and chose to go ahead.
                allowPartialDeviceCoverage: unreachable.length > 0 ? true : undefined,
            }));

            // The server mints generation 1 for a conversation created encrypted.
            await this.mlsService.registerGroup(conv.id, 1, groupIdB64);

            this.conversationStore.addConversation(conv);
            this.navService.openConversation(conv);

            // Read again off the creation response: a device that registered between our own check
            // and this call shows up only here. A last-resort package is a weaker warning, not a
            // failure: the device can read the conversation, but its leaf loses forward secrecy.
            const missedByServer = (conv.unreachableDevices ?? []).map(d => d.deviceName);
            const onLastResort = invitees.filter(t => t.isLastResort).length;

            if (missedByServer.length === 0 && onLastResort === 0) {
                this.close();
                return;
            }

            // The conversation exists and is open behind the dialog; this stays up until it is
            // acknowledged, because "some of these people cannot read this" is not something to
            // report by dismissing the only surface that could report it.
            this.createdWarning.set({devices: missedByServer, lastResortCount: onLastResort});
            this.creating.set(false);
        } catch (err) {
            console.error('Failed to create encrypted conversation', err);
            await firstValueFrom(this.mlsService.deleteGroup(groupIdB64)).catch(() => undefined);
            this.creating.set(false);
        }
    }
}
