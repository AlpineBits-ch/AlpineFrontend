import {Component, computed, inject, signal} from '@angular/core';
import {NgClass} from "@angular/common";
import {AppAvatarComponent} from "../../../../components/avatar/avatar.component";
import {Button} from "primeng/button";
import {FormsModule} from "@angular/forms";
import {RelationshipService} from "../../../../services/relationship.service";
import {RelationshipModel, RelationshipStatus} from "../../../friendship/components/friendship-modal/dto/relationship.model";
import {ConversationService} from "../../../../services/conversation.service";
import {ConversationEncryption} from "../../../../enums/conversation-encryption.enum";
import {ProfileService} from "../../../../services/profile.service";
import {OnlineStatus} from "../../../../dtos/response/profile.dto";

type FriendsTab = 'online' | 'all' | 'pending' | 'blocked';

@Component({
  selector: 'app-home',
  imports: [AppAvatarComponent, Button, FormsModule, NgClass],
  templateUrl: './home.component.html',
  styleUrl: './home.component.css',
})
export class HomeComponent {
  private relationshipService = inject(RelationshipService);
  private profileService = inject(ProfileService);

  public tab = signal<FriendsTab>('online');
  public addFriendOpen = signal(false);
  public friendInput = '';

  public conversationService = inject(ConversationService);
  public relationships = signal<RelationshipModel[]>([]);

  public incoming     = computed(() => this.relationships().filter(r => r.status === RelationshipStatus.PendingIncoming));
  public outgoing     = computed(() => this.relationships().filter(r => r.status === RelationshipStatus.PendingOutgoing));
  public friends      = computed(() => this.relationships().filter(r => r.status === RelationshipStatus.Friends));
  public onlineFriends = computed(() => this.friends().filter(r => this.profileService.getOnlineStatus(r.target.userId) === OnlineStatus.Online));
  public blocked      = computed(() => this.relationships().filter(r => r.status === RelationshipStatus.Blocked));
  public pendingCount = computed(() => this.incoming().length + this.outgoing().length);

  protected readonly OnlineStatus = OnlineStatus;

  public getOnlineStatus(userId: string): OnlineStatus {
    return this.profileService.getOnlineStatus(userId);
  }

  constructor() {
    this.load();
  }

  private load(): void {
    this.relationshipService.getRelationships().subscribe(d => {
      this.relationships.set(d);
      d.filter(r => r.status === RelationshipStatus.Friends)
       .forEach(r => this.profileService.resolveByUserId(r.target.userId));
    });
  }

  public sendRequest(): void {
    const parts = this.friendInput.trim().split('#');
    if (parts.length !== 2) return;
    const username = parts[0];
    const hash = Number.parseInt(parts[1]);
    if (isNaN(hash)) return;
    this.relationshipService.createFriendRequest(username, hash).subscribe(() => {
      this.friendInput = '';
      this.addFriendOpen.set(false);
      this.load();
    });
  }

  public accept(id: string): void {
    this.relationshipService.acceptFriendRequest(id).subscribe(() => this.load());
  }

  public decline(id: string): void {
    this.relationshipService.rejectFriendRequest(id).subscribe(() => this.load());
  }

  public cancel(id: string): void {
    this.relationshipService.revokeFriendRequest(id).subscribe(() => this.load());
  }

  public block(id: string): void {
    // TODO: wire up block endpoint when available
    console.log('Block user relationship:', id);
  }

  public unblock(id: string): void {
    // TODO: wire up unblock endpoint when available
    console.log('Unblock user relationship:', id);
  }

  public createConversation(id: string): void {
    this.conversationService.createConversation({
      members: [{
        userId: id
      }],
      name: undefined,
      encryption: ConversationEncryption.Plain
    }).subscribe(() => this.load());
  }

  protected readonly RelationshipStatus = RelationshipStatus;
}
