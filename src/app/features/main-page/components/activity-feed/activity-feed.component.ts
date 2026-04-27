import { Component, inject } from '@angular/core';
import { Avatar } from 'primeng/avatar';
import { Button } from 'primeng/button';
import { ProfileService } from '../../../../services/profile.service';

@Component({
  selector: 'app-activity-feed',
  imports: [Avatar, Button],
  templateUrl: './activity-feed.component.html',
  styleUrl: './activity-feed.component.css',
})
export class ActivityFeedComponent {
  protected profileService = inject(ProfileService);
}
