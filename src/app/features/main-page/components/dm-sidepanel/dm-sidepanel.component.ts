import { Component, inject, signal } from '@angular/core';
import { Button } from 'primeng/button';
import { ConversationListComponent } from '../conversation-list/conversation-list.component';
import { NavigationService } from '../../navigation.service';
import { ConversationDto } from '../../../../dtos/response/conversation.dto';
import { NewConversationDialogComponent } from './new-conversation-dialog/new-conversation-dialog.component';

@Component({
  selector: 'app-dm-sidepanel',
  imports: [Button, ConversationListComponent, NewConversationDialogComponent],
  templateUrl: './dm-sidepanel.component.html',
})
export class DmSidepanelComponent {
  protected navService = inject(NavigationService);
  protected showNewConversation = signal(false);

  onConversationSelected(conv: ConversationDto): void {
    this.navService.openConversation(conv);
  }
}
