import {Component, computed, inject, input} from '@angular/core';
import {NgClass} from '@angular/common';
import {ConversationDto} from '../../../../dtos/response/conversation.dto';
import {OnlineStatus} from '../../../../dtos/response/profile.dto';
import {AppAvatarComponent} from '../../../../components/avatar/avatar.component';
import {UserStatusDotComponent} from '../../../../components/user-status-dot/user-status-dot.component';
import {ProfileService} from '../../../../services/profile.service';
import {ConversationUtilsService} from '../../../../services/conversation-utils.service';
import {ProfileDialogService} from '../../../../services/profile-dialog.service';
import {ActivityCardComponent} from '../../../../components/activity-card/activity-card.component';
import {UserActivityService} from '../../../../services/user-activity.service';
import {Activity} from '../../../../models/activity.model';

@Component({
    selector: 'app-conversation-info-panel',
    imports: [AppAvatarComponent, NgClass, UserStatusDotComponent, ActivityCardComponent],
    templateUrl: './conversation-info-panel.component.html',
    styleUrl: './conversation-info-panel.component.css',
})
export class ConversationInfoPanelComponent {
    conversation = input.required<ConversationDto>();
    protected convUtils = inject(ConversationUtilsService);
    protected profileDialogSvc = inject(ProfileDialogService);
    protected others = computed(() => this.convUtils.getOtherMembers(this.conversation()));
    protected isDirect = computed(() => this.others().length === 1);
    protected readonly OnlineStatus = OnlineStatus;
    private profileService = inject(ProfileService);
    private userActivity = inject(UserActivityService);

    protected getOnlineStatus(userId: string): OnlineStatus {
        return this.profileService.getOnlineStatus(userId);
    }

    protected activitiesFor(userId: string): Activity[] {
        return this.userActivity.activitiesFor(userId);
    }
}
