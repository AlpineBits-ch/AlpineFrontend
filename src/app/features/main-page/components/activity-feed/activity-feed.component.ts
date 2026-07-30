import {Component, computed, inject, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {AppAvatarComponent} from '../../../../components/avatar/avatar.component';
import {EmptyStateComponent} from '../../../../components/empty-state/empty-state.component';
import {ProfileService} from '../../../../services/profile.service';
import {ProfileDialogService} from '../../../../services/profile-dialog.service';
import {RelationshipStore} from '../../../../stores/relationship.store';
import {RelationshipView} from '../../../friendship/components/friendship-modal/dto/relationship.model';
import {OnlineStatus} from '../../../../dtos/response/profile.dto';
import {TranslateModule} from '@ngx-translate/core';

export interface ActivityStatus {
    type: 'playing' | 'listening' | 'watching' | 'streaming';
    label: string;
    detail?: string;
    since?: Date;
}

@Component({
    selector: 'app-activity-feed',
    imports: [AppAvatarComponent, TranslateModule, NgClass, EmptyStateComponent],
    templateUrl: './activity-feed.component.html',
    styleUrl: './activity-feed.component.css',
})
export class ActivityFeedComponent {
    protected profileService = inject(ProfileService);
    protected profileDialogSvc = inject(ProfileDialogService);
    private relationshipStore = inject(RelationshipStore);
    // Keyed by friend's userId -empty by default until activity data arrives
    protected activityStatuses = signal<Record<string, ActivityStatus>>({});
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

    protected activityFor(r: RelationshipView): ActivityStatus | undefined {
        return this.activityStatuses()[r.other.userId];
    }

    protected formatSince(since: Date): string {
        const mins = Math.floor((Date.now() - since.getTime()) / 60_000);
        if (mins < 60) return `${mins}m`;
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return m > 0 ? `${h}h ${m}m` : `${h}h`;
    }

    protected activityIcon(status: ActivityStatus): string {
        switch (status.type) {
            case 'playing': return 'pi-play-circle';
            case 'listening': return 'pi-volume-up';
            case 'watching': return 'pi-eye';
            case 'streaming': return 'pi-video';
        }
    }
}
