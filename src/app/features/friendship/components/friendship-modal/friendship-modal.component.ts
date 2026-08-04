import {Component, inject, model} from '@angular/core';
import {Dialog} from "primeng/dialog";
import {RelationshipStatus, RelationshipView} from "./dto/relationship.model";
import {RelationshipStore} from "../../../../stores/relationship.store";
import {Button} from "primeng/button";
import {Tag} from "primeng/tag";
import {Avatar} from "primeng/avatar";
import {PrimeTemplate} from "primeng/api";
import {InputText} from "primeng/inputtext";
import {Tooltip} from "primeng/tooltip";
import {FormsModule} from "@angular/forms";
import {ConversationService} from "../../../../services/conversation.service";
import {ConversationEncryption} from "../../../../enums/conversation-encryption.enum";
import {ConversationStore} from "../../../../stores/conversation.store";
import {NavigationService} from "../../../main-page/navigation.service";
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {SocialKeyGateService} from '../../../../services/social-key-gate.service';
import {ToastService} from '../../../../services/toast.service';
import {refusalMessageKey} from '../../../../core/refusal-message';

@Component({
    selector: 'app-friendship-modal',
    imports: [
        Dialog,
        Button,
        Tag,
        Avatar,
        PrimeTemplate,
        InputText,
        Tooltip,
        FormsModule,
        TranslateModule
    ],
    templateUrl: './friendship-modal.component.html',
    styleUrl: './friendship-modal.component.css',
})
export class FriendshipModalComponent {
    public isVisible = model.required<boolean>();
    public conversationService = inject(ConversationService);
    public friendId: string = '';
    protected readonly RelationshipStatus = RelationshipStatus;
    private relationshipStore = inject(RelationshipStore);
    public incomingFriendRequest = this.relationshipStore.incoming;
    public outgoingFriendRequest = this.relationshipStore.outgoing;
    public friends = this.relationshipStore.friends;
    private conversationStore = inject(ConversationStore);
    private navService = inject(NavigationService);
    private socialGate = inject(SocialKeyGateService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);

    constructor() {
        // The store keeps itself current from the social.* realtime events -no reload here.
        this.relationshipStore.load();
    }

    public sendFriendrequest() {
        const username = this.friendId.trim();
        if (!username) return;
        // Declining leaves the typed username in the field to try again with.
        if (!this.socialGate.isSatisfied()) {
            void this.socialGate.require().then(allowed => {
                if (allowed) this.sendFriendrequest();
            });
            return;
        }
        this.relationshipStore.sendRequest(username).subscribe({
            next: () => this.friendId = '',
            // The target's friend-request policy or a block can refuse this (T2-15). The message
            // stays vague on purpose: which rule refused, and whether the account exists at all,
            // are both things the endpoint must not become a way to find out.
            error: (err: unknown) => {
                const key = refusalMessageKey(err);
                if (key) this.toast.error(this.translate.instant(key));
                else this.toast.httpError('Could not send that friend request', err);
            },
        });
    }

    public acceptFriendRequest(id: string) {
        if (!this.socialGate.isSatisfied()) {
            void this.socialGate.require().then(allowed => {
                if (allowed) this.acceptFriendRequest(id);
            });
            return;
        }
        this.relationshipStore.accept(id).subscribe();
    }

    public rejectFriendRequest(id: string) {
        this.relationshipStore.reject(id).subscribe();
    }

    public onMessageClick(relationship: RelationshipView): void {
        const targetUserId = relationship.other.userId;

        const existing = this.conversationStore.entities().find(conv =>
            conv.members.length === 2 && conv.members.some(m => m.userId === targetUserId)
        );

        if (existing) {
            this.navService.openConversation(existing);
            this.isVisible.set(false);
            return;
        }

        this.conversationService.createConversation({
            members: [{userId: targetUserId}],
            encryption: ConversationEncryption.Plain,
            name: undefined,
            deviceWelcomes: [],
        }).subscribe({
            next: conv => {
                this.conversationStore.addConversation(conv);
                this.navService.openConversation(conv);
                this.isVisible.set(false);
            },
            // Refused by the recipient's DM policy or a block (T0-2) - say so rather than leaving
            // the modal sitting open with no explanation.
            error: (err: unknown) => {
                const key = refusalMessageKey(err);
                if (key) this.toast.error(this.translate.instant(key));
                else this.toast.httpError('Could not open that conversation', err);
            },
        });
    }
}
