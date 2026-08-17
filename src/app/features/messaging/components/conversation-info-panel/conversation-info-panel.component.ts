import {Component, computed, effect, inject, input} from '@angular/core';
import {NgClass} from '@angular/common';
import {MlsCoverageDevicesComponent} from '../../../../components/mls-coverage-devices/mls-coverage-devices.component';
import {MlsCoverageService} from '../../../../services/mls-coverage.service';
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
    imports: [
        AppAvatarComponent, NgClass, UserStatusDotComponent, ActivityCardComponent,
        MlsCoverageDevicesComponent,
    ],
    templateUrl: './conversation-info-panel.component.html',
    styleUrl: './conversation-info-panel.component.css',
})
export class ConversationInfoPanelComponent {
    readonly conversation = input.required<ConversationDto>();
    protected convUtils = inject(ConversationUtilsService);
    protected profileDialogSvc = inject(ProfileDialogService);
    protected readonly others = computed(() => this.convUtils.getOtherMembers(this.conversation()));
    protected readonly isDirect = computed(() => this.others().length === 1);
    protected readonly OnlineStatus = OnlineStatus;
    private profileService = inject(ProfileService);
    private userActivity = inject(UserActivityService);
    private readonly coverage = inject(MlsCoverageService);

    /**
     * This panel is the conversation's encryption screen, so opening it is an explicit ask and gets
     * a fresh answer rather than whatever the message view cached on open.
     */
    constructor() {
        effect(() => {
            const conversationId = this.conversation().id;
            void this.coverage.refresh(conversationId, false);
        });
    }

    protected readonly hasDeviceReport = computed(
        () => this.coverage.hasDeviceReport(this.conversation().id));

    /**
     * `userId -> display name`, so a stranded device can be named after whoever owns it. The
     * coverage response carries a user id and a device name and nothing else.
     */
    protected readonly ownerNames = computed(() => Object.fromEntries(
        this.others().map(member => [member.userId, member.cachedUserName])));

    protected getOnlineStatus(userId: string): OnlineStatus {
        return this.profileService.getOnlineStatus(userId);
    }

    protected activitiesFor(userId: string): Activity[] {
        return this.userActivity.activitiesFor(userId);
    }
}
