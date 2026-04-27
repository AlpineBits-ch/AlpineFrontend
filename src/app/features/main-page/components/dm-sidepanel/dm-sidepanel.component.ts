import { Component, inject } from '@angular/core';
import { Button } from 'primeng/button';
import { ConversationListComponent } from '../conversation-list/conversation-list.component';
import { NavigationService } from '../../navigation.service';
import { ConversationDto } from '../../../../dtos/response/conversation.dto';

@Component({
  selector: 'app-dm-sidepanel',
  imports: [Button, ConversationListComponent],
  templateUrl: './dm-sidepanel.component.html',
})
export class DmSidepanelComponent {
  protected navService = inject(NavigationService);

  onConversationSelected(conv: ConversationDto): void {
    this.navService.openConversation(conv);
  }
}
