import {Component, computed, inject, model, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {NgClass} from '@angular/common';
import {from, map, of, switchMap} from 'rxjs';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Avatar} from 'primeng/avatar';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {PrimeTemplate} from 'primeng/api';
import {RelationshipService} from '../../../../../services/relationship.service';
import {ConversationService} from '../../../../../services/conversation.service';
import {MlsService} from '../../../../../services/mls.service';
import {ConversationStore} from '../../../../../stores/conversation.store';
import {NavigationService} from '../../../navigation.service';
import {ProfileService} from '../../../../../services/profile.service';
import {
    MinimalProfileId,
    RelationshipModel,
    RelationshipStatus,
} from '../../../../friendship/components/friendship-modal/dto/relationship.model';
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
    readonly friends = signal<MinimalProfileId[]>([]);
    readonly search = signal('');
    readonly selectedIds = signal(new Set<string>());
    readonly groupName = signal('');
    readonly encrypted = signal(false);
    readonly creating = signal(false);
    readonly filteredFriends = computed(() => {
        const q = this.search().toLowerCase();
        return q
            ? this.friends().filter(f => `${f.userName}#${f.hash}`.toLowerCase().includes(q))
            : this.friends();
    });
    readonly selectedFriends = computed(() =>
        this.friends().filter(f => this.selectedIds().has(f.userId))
    );
    readonly isGroup = computed(() => this.selectedIds().size >= 2);
    readonly canCreate = computed(() => this.selectedIds().size >= 1 && !this.creating());
    private relationshipService = inject(RelationshipService);
    private conversationService = inject(ConversationService);
    private mlsService = inject(MlsService);
    private conversationStore = inject(ConversationStore);
    private navService = inject(NavigationService);
    private profileService = inject(ProfileService);

    constructor() {
        this.relationshipService.getRelationships().subscribe((rels: RelationshipModel[]) => {
            const ownId = this.profileService.ownProfile()?.userId;
            const friends = rels
                .filter(r => r.status === RelationshipStatus.Friends)
                .map(r => (r.owner.userId === ownId ? r.target : r.owner));
            this.friends.set(friends);
        });
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
    }

    private createEncrypted(members: { userId: string }[], name: string | undefined): void {
        const ownId = this.profileService.ownProfile()?.userId;
        const keyHandle = this.mlsService.keyHandle();

        if (!ownId || !keyHandle) {
            this.creating.set(false);
            return;
        }

        const allUserIds = [ownId, ...Array.from(this.selectedIds())];

        from(this.mlsService.getOrCreateDeviceIdentifier()).pipe(
            switchMap(ownDeviceId =>
                this.conversationService.getMlsTokensForUserIds(allUserIds).pipe(
                    map(({deviceTokens}) => ({ownDeviceId, deviceTokens}))
                )
            ),
            switchMap(({ownDeviceId, deviceTokens}) => {
                const otherTokens = deviceTokens.filter(t => t.deviceId !== ownDeviceId);

                const groupIdBytes = crypto.getRandomValues(new Uint8Array(16));
                const groupIdB64 = btoa(String.fromCharCode(...groupIdBytes));

                return this.mlsService.createGroup(groupIdB64, keyHandle).pipe(
                    switchMap(() => {
                        if (otherTokens.length === 0) {
                            return of({
                                groupIdB64,
                                epoch: 0,
                                deviceWelcomes: [] as DeviceWelcomeDto[],
                                mlsGroupInfo: undefined as string | undefined
                            });
                        }

                        const keyPackagesB64 = otherTokens.map(t => t.token);
                        return this.mlsService.addMembers(groupIdB64, keyHandle, keyPackagesB64).pipe(
                            switchMap(commitOut => {
                                const welcome = commitOut.welcome!;
                                const deviceWelcomes: DeviceWelcomeDto[] = otherTokens.map(t => ({
                                    deviceId: t.deviceId,
                                    welcome,
                                    userId: t.userId,
                                }));
                                return this.mlsService.exportGroupInfo(groupIdB64, keyHandle).pipe(
                                    map(mlsGroupInfo => ({
                                        groupIdB64,
                                        epoch: commitOut.epoch,
                                        deviceWelcomes,
                                        mlsGroupInfo
                                    }))
                                );
                            })
                        );
                    })
                );
            }),
            switchMap(({groupIdB64, epoch, deviceWelcomes, mlsGroupInfo}) =>
                this.conversationService.createConversation({
                    name,
                    members,
                    encryption: ConversationEncryption.Encrypted,
                    deviceWelcomes,
                    mlsGroupId: groupIdB64,
                    mlsEpoch: epoch,
                    mlsGroupInfo,
                }).pipe(map(conv => ({conv, groupIdB64})))
            )
        ).subscribe({
            next: ({conv, groupIdB64}) => {
                void this.mlsService.registerGroupForConversation(conv.id, groupIdB64);
                this.conversationStore.addConversation(conv);
                this.navService.openConversation(conv);
                this.close();
            },
            error: () => this.creating.set(false),
        });
    }
}
