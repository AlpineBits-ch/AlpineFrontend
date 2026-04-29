import {Component, computed, inject, input, model, signal} from '@angular/core';
import {Dialog} from "primeng/dialog";
import {RelationshipModel, RelationshipStatus} from "./dto/relationship.model";
import {Button} from "primeng/button";
import {Fieldset} from "primeng/fieldset";
import {Tag} from "primeng/tag";
import {Listbox} from "primeng/listbox";
import {Avatar} from "primeng/avatar";
import {PrimeTemplate} from "primeng/api";
import {InputText} from "primeng/inputtext";
import {Tooltip} from "primeng/tooltip";
import {RelationshipService} from "../../../../services/relationship.service";
import {FormsModule} from "@angular/forms";
import {ConversationService} from "../../../../services/conversation.service";
import {ConversationEncryption} from "../../../../enums/conversation-encryption.enum";
import {ConversationStore} from "../../../../stores/conversation.store";
import {NavigationService} from "../../../main-page/navigation.service";
import {ProfileService} from "../../../../services/profile.service";

@Component({
  selector: 'app-friendship-modal',
  imports: [
    Dialog,
    Button,
    Fieldset,
    Tag,
    Listbox,
    Avatar,
    PrimeTemplate,
    InputText,
    Tooltip,
    FormsModule
  ],
  templateUrl: './friendship-modal.component.html',
  styleUrl: './friendship-modal.component.css',
})
export class FriendshipModalComponent {
  public isVisible = model.required<boolean>();
  public conversationService = inject(ConversationService);
  public relationships = signal<RelationshipModel[]>([])

  public incomingFriendRequest = computed(() => {
    return this.relationships().filter(r => r.status === RelationshipStatus.PendingIncoming);
  })

  public outgoingFriendRequest = computed(() => {
    return this.relationships().filter(r => r.status === RelationshipStatus.PendingOutgoing);
  })

  public friends = computed(() => {
    return this.relationships().filter(r => r.status === RelationshipStatus.Friends);
  })

  private relationshipService = inject(RelationshipService);
  private conversationStore = inject(ConversationStore);
  private navService = inject(NavigationService);
  private profileService = inject(ProfileService);

  public friendId: string = '';
  constructor() {
    this.relationshipService.getRelationships().subscribe(d => {
      this.relationships.set(d);
    })
  }

  public sendFriendrequest(){

    const id= Number.parseInt(this.friendId.split('#')[1]);
    const username = this.friendId.split('#')[0];

    this.relationshipService.createFriendRequest(username, id).subscribe(d => {
      console.log(d);
    })
  }

  public acceptFriendRequest(id: string){


    this.relationshipService.acceptFriendRequest(id).subscribe(d => {
      console.log(d);
    })
  }

  public rejectFriendRequest(id: string){


    this.relationshipService.rejectFriendRequest(id).subscribe(d => {
      console.log(d);
    })
  }

  public onMessageClick(relationship: RelationshipModel): void {
    const ownId = this.profileService.ownProfile()?.userId;
    const targetUserId = relationship.owner.userId === ownId
      ? relationship.target.userId
      : relationship.owner.userId;

    const existing = this.conversationStore.entities().find(conv =>
      conv.members.length === 2 && conv.members.some(m => m.userId === targetUserId)
    );

    if (existing) {
      this.navService.openConversation(existing);
      this.isVisible.set(false);
      return;
    }

    this.conversationService.createConversation({
      members: [{ userId: targetUserId }],
      encryption: ConversationEncryption.Plain,
      name: undefined,
    }).subscribe(conv => {
      this.conversationStore.addConversation(conv);
      this.navService.openConversation(conv);
      this.isVisible.set(false);
    });
  }

    protected readonly RelationshipStatus = RelationshipStatus;
}
