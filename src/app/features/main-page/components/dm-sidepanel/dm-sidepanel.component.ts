import { Component, computed, inject, signal } from '@angular/core';
import { Button } from 'primeng/button';
import { ConversationListComponent } from '../../../messaging/components/conversation-list/conversation-list.component';
import { NavigationService } from '../../navigation.service';
import { ConversationDto } from '../../../../dtos/response/conversation.dto';
import { NewConversationDialogComponent } from './new-conversation-dialog/new-conversation-dialog.component';
import { RelationshipService } from '../../../../services/relationship.service';
import { ProfileService } from '../../../../services/profile.service';
import { RelationshipModel, RelationshipStatus } from '../../../friendship/components/friendship-modal/dto/relationship.model';
import { OnlineStatus } from '../../../../dtos/response/profile.dto';

@Component({
  selector: 'app-dm-sidepanel',
  imports: [Button, ConversationListComponent, NewConversationDialogComponent],
  templateUrl: './dm-sidepanel.component.html',
})
export class DmSidepanelComponent {
  protected navService = inject(NavigationService);
  private relationshipService = inject(RelationshipService);
  private profileService = inject(ProfileService);

  protected showNewConversation = signal(false);
  private relationships = signal<RelationshipModel[]>([]);

  protected onlineFriendsCount = computed(() =>
    this.relationships()
      .filter(r => r.status === RelationshipStatus.Friends &&
                   this.profileService.getOnlineStatus(r.target.userId) === OnlineStatus.Online)
      .length
  );

  constructor() {
    this.relationshipService.getRelationships().subscribe(d => {
      this.relationships.set(d);
      d.filter(r => r.status === RelationshipStatus.Friends)
       .forEach(r => this.profileService.resolveByUserId(r.target.userId));
    });
  }

  onConversationSelected(conv: ConversationDto): void {
    this.navService.openConversation(conv);
  }
}
