import { Component, computed, inject, signal } from '@angular/core';
import { Avatar } from 'primeng/avatar';
import { ProfileService } from '../../../../services/profile.service';
import { RelationshipService } from '../../../../services/relationship.service';
import { RelationshipModel, RelationshipStatus } from '../../../friendship/components/friendship-modal/dto/relationship.model';
import { OnlineStatus } from '../../../../dtos/response/profile.dto';
import { TranslateModule } from '@ngx-translate/core';

export interface ActivityStatus {
  type: 'playing' | 'listening' | 'watching' | 'streaming';
  label: string;
  detail?: string;
  since?: Date;
}

@Component({
  selector: 'app-activity-feed',
  imports: [Avatar, TranslateModule],
  templateUrl: './activity-feed.component.html',
  styleUrl: './activity-feed.component.css',
})
export class ActivityFeedComponent {
  protected profileService = inject(ProfileService);
  private relationshipService = inject(RelationshipService);

  protected relationships = signal<RelationshipModel[]>([]);

  // Keyed by friend's userId — empty by default until activity data arrives
  protected activityStatuses = signal<Record<string, ActivityStatus>>({});

  protected friends = computed(() =>
    this.relationships().filter(r => r.status === RelationshipStatus.Friends)
  );

  protected onlineFriends = computed(() =>
    this.friends().filter(r =>
      this.profileService.getOnlineStatus(this.friendUserId(r)) === OnlineStatus.Online
    )
  );

  protected offlineFriends = computed(() =>
    this.friends().filter(r =>
      this.profileService.getOnlineStatus(this.friendUserId(r)) !== OnlineStatus.Online
    )
  );

  constructor() {
    this.relationshipService.getRelationships().subscribe(rels => {
      this.relationships.set(rels);
      rels
        .filter(r => r.status === RelationshipStatus.Friends)
        .forEach(r => this.profileService.resolveByUserId(this.friendUserId(r)));
    });
  }

  protected friendProfile(r: RelationshipModel) {
    const ownId = this.profileService.ownProfile()?.userId;
    return r.owner.userId === ownId ? r.target : r.owner;
  }

  protected friendUserId(r: RelationshipModel): string {
    return this.friendProfile(r).userId;
  }

  protected activityFor(r: RelationshipModel): ActivityStatus | undefined {
    return this.activityStatuses()[this.friendUserId(r)];
  }

  protected formatSince(since: Date): string {
    const mins = Math.floor((Date.now() - since.getTime()) / 60_000);
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
}
