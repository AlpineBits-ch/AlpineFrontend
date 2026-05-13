import { Component, computed, inject, signal } from '@angular/core';
import { Button } from 'primeng/button';
import { ConversationListComponent } from '../../../messaging/components/conversation-list/conversation-list.component';
import { NavigationService } from '../../navigation.service';
import { ConversationDto } from '../../../../dtos/response/conversation.dto';
import { NewConversationDialogComponent } from '../../components/dm-sidepanel/new-conversation-dialog/new-conversation-dialog.component';
import { RelationshipService } from '../../../../services/relationship.service';
import { ProfileService } from '../../../../services/profile.service';
import { RelationshipModel, RelationshipStatus } from '../../../friendship/components/friendship-modal/dto/relationship.model';
import { OnlineStatus } from '../../../../dtos/response/profile.dto';
import { TranslateModule } from '@ngx-translate/core';

@Component({
  selector: 'app-mobile-conversations-page',
  imports: [Button, ConversationListComponent, NewConversationDialogComponent, TranslateModule],
  templateUrl: './mobile-conversations-page.component.html',
})
export class MobileConversationsPageComponent {
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
    });
  }

  onConversationSelected(conv: ConversationDto): void {
    this.navService.openConversation(conv);
  }
}
