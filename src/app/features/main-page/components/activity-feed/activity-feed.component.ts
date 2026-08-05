import {Component, computed, inject} from '@angular/core';
import {NgClass} from '@angular/common';
import {AppAvatarComponent} from '../../../../components/avatar/avatar.component';
import {EmptyStateComponent} from '../../../../components/empty-state/empty-state.component';
import {ProfileService} from '../../../../services/profile.service';
import {ProfileDialogService} from '../../../../services/profile-dialog.service';
import {RelationshipStore} from '../../../../stores/relationship.store';
import {RelationshipView} from '../../../friendship/components/friendship-modal/dto/relationship.model';
import {OnlineStatus} from '../../../../dtos/response/profile.dto';
import {TranslateModule} from '@ngx-translate/core';
import {ActivityLineComponent} from '../../../../components/activity-line/activity-line.component';
import {UserActivityService} from '../../../../services/user-activity.service';
import {Activity, ACTIVITY_TYPE_ICONS} from '../../../../models/activity.model';

@Component({
    selector: 'app-activity-feed',
    imports: [AppAvatarComponent, TranslateModule, NgClass, EmptyStateComponent, ActivityLineComponent],
    templateUrl: './activity-feed.component.html',
    styleUrl: './activity-feed.component.css',
})
export class ActivityFeedComponent {
    protected profileService = inject(ProfileService);
    protected profileDialogSvc = inject(ProfileDialogService);
    private relationshipStore = inject(RelationshipStore);
    private userActivity = inject(UserActivityService);
    protected friends = this.relationshipStore.friends;
    protected onlineFriends = computed(() =>
        this.friends().filter(r =>
            this.profileService.getOnlineStatus(r.other.userId) === OnlineStatus.Online
        )
    );
    // "Active Now" - friends with a live rich-presence activity get a card; everyone else
    // online falls back to the plain roster row.
    protected activeNowFriends = computed(() =>
        this.onlineFriends().filter(r => this.activityFor(r))
    );
    protected plainOnlineFriends = computed(() =>
        this.onlineFriends().filter(r => !this.activityFor(r))
    );
    protected offlineFriends = computed(() =>
        this.friends().filter(r =>
            this.profileService.getOnlineStatus(r.other.userId) !== OnlineStatus.Online
        )
    );

    constructor() {
        this.relationshipStore.load();
    }

    /**
     * This panel used to hold its own `activityStatuses` signal and its own `ActivityStatus`
     * shape - both stubs, the signal permanently empty, so the "Active Now" section could never
     * appear. They are gone: the data is real now and comes from the same store every other
     * surface reads, in the shape the server actually sends.
     */
    protected activityFor(r: RelationshipView): Activity | null {
        return this.userActivity.primaryFor(r.other.userId);
    }

    protected activityIcon(activity: Activity): string {
        return ACTIVITY_TYPE_ICONS[activity.type];
    }
}
