import {Component, computed, inject, signal} from '@angular/core';
import {NgClass} from "@angular/common";
import {AppAvatarComponent} from "../../../../components/avatar/avatar.component";
import {UserStatusDotComponent} from "../../../../components/user-status-dot/user-status-dot.component";
import {EmptyStateComponent} from "../../../../components/empty-state/empty-state.component";
import {Button} from "primeng/button";
import {FormsModule} from "@angular/forms";
import {RelationshipStatus} from "../../../friendship/components/friendship-modal/dto/relationship.model";
import {RelationshipStore} from "../../../../stores/relationship.store";
import {ConversationService} from "../../../../services/conversation.service";
import {ConversationEncryption} from "../../../../enums/conversation-encryption.enum";
import {ProfileService} from "../../../../services/profile.service";
import {OnlineStatus} from "../../../../dtos/response/profile.dto";
import {ProfileDialogService} from "../../../../services/profile-dialog.service";
import {NavigationService} from "../../navigation.service";
import {ConversationStore} from "../../../../stores/conversation.store";
import {TranslateModule} from '@ngx-translate/core';

type FriendsTab = 'online' | 'all' | 'pending' | 'blocked';

@Component({
    selector: 'app-home',
    imports: [AppAvatarComponent, Button, FormsModule, NgClass, TranslateModule, UserStatusDotComponent, EmptyStateComponent],
    templateUrl: './home.component.html',
    styleUrl: './home.component.css',
})
export class HomeComponent {
    public tab = signal<FriendsTab>('online');
    public addFriendOpen = signal(false);
    public friendInput = '';
    public conversationService = inject(ConversationService);
    protected profileDialogSvc = inject(ProfileDialogService);
    protected navService = inject(NavigationService);
    protected readonly OnlineStatus = OnlineStatus;
    protected readonly RelationshipStatus = RelationshipStatus;
    private relationshipStore = inject(RelationshipStore);
    public incoming = this.relationshipStore.incoming;
    public outgoing = this.relationshipStore.outgoing;
    public friends = this.relationshipStore.friends;
    public blocked = this.relationshipStore.blocked;
    public pendingCount = this.relationshipStore.pendingCount;
    private profileService = inject(ProfileService);
    public onlineFriends = computed(() => this.friends().filter(r => this.isActiveStatus(this.profileService.getOnlineStatus(r.other.userId))));
    private conversationStore = inject(ConversationStore);

    constructor() {
        // The store keeps itself current from the social.* realtime events -no reload here.
        this.relationshipStore.load();
    }

    public getOnlineStatus(userId: string): OnlineStatus {
        return this.profileService.getOnlineStatus(userId);
    }

    public isActiveStatus(status: OnlineStatus): boolean {
        return status === OnlineStatus.Online || status === OnlineStatus.Idle || status === OnlineStatus.DoNotDisturb;
    }

    public statusTextClass(status: OnlineStatus): string {
        switch (status) {
            case OnlineStatus.Online: return 'text-online/80';
            case OnlineStatus.Idle: return 'text-connecting/80';
            case OnlineStatus.DoNotDisturb: return 'text-offline/80';
            default: return 'text-white/35';
        }
    }

    public statusLabelKey(status: OnlineStatus): string {
        switch (status) {
            case OnlineStatus.Online: return 'HOME.STATUS.ONLINE';
            case OnlineStatus.Idle: return 'HOME.STATUS.IDLE';
            case OnlineStatus.DoNotDisturb: return 'HOME.STATUS.DND';
            case OnlineStatus.Hidden: return 'HOME.STATUS.HIDDEN';
            default: return 'HOME.STATUS.OFFLINE';
        }
    }

    public sendRequest(): void {
        const username = this.friendInput.trim();
        if (!username) return;
        this.relationshipStore.sendRequest(username).subscribe(() => {
            this.friendInput = '';
            this.addFriendOpen.set(false);
        });
    }

    public accept(id: string): void {
        this.relationshipStore.accept(id).subscribe();
    }

    public decline(id: string): void {
        this.relationshipStore.reject(id).subscribe();
    }

    public cancel(id: string): void {
        this.relationshipStore.revoke(id).subscribe();
    }

    public block(id: string): void {
        // TODO: wire up block endpoint when available
        console.log('Block user relationship:', id);
    }

    public unblock(id: string): void {
        // TODO: wire up unblock endpoint when available
        console.log('Unblock user relationship:', id);
    }

    public openOrCreateDm(targetUserId: string): void {
        const ownId = this.profileService.ownProfile()?.userId;
        const existing = this.conversationStore.entities().find(c =>
            c.members.length === 2 &&
            c.members.some(m => m.userId === ownId) &&
            c.members.some(m => m.userId === targetUserId)
        );
        if (existing) {
            this.navService.openConversation(existing);
            return;
        }
        this.conversationService.createConversation({
            members: [{userId: targetUserId}],
            name: undefined,
            encryption: ConversationEncryption.Plain,
            deviceWelcomes: [],
        }).subscribe(conv => {
            this.conversationStore.addConversation(conv);
            this.navService.openConversation(conv);
        });
    }
}
