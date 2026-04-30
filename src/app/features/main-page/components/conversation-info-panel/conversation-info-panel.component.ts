import { Component, computed, inject, input } from '@angular/core';
import { AppAvatarComponent } from '../../../../components/avatar/avatar.component';
import { NgClass } from '@angular/common';
import { ConversationDto } from '../../../../dtos/response/conversation.dto';
import { ProfileService } from '../../../../services/profile.service';
import { OnlineStatus } from '../../../../dtos/response/profile.dto';

@Component({
  selector: 'app-conversation-info-panel',
  imports: [AppAvatarComponent, NgClass],
  templateUrl: './conversation-info-panel.component.html',
  styleUrl: './conversation-info-panel.component.css',
})
export class ConversationInfoPanelComponent {
  conversation = input.required<ConversationDto>();

  private profileService = inject(ProfileService);

  protected others = computed(() => {
    const ownId = this.profileService.ownProfile()?.userId;
    return this.conversation().members.filter(m => m.userId !== ownId);
  });

  protected isDirect = computed(() => this.others().length === 1);

  protected readonly OnlineStatus = OnlineStatus;

  protected getOnlineStatus(userId: string): OnlineStatus {
    return this.profileService.getOnlineStatus(userId);
  }
}
