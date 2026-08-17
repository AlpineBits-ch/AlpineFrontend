import {Component, input, output} from '@angular/core';
import {DatePipe} from '@angular/common';
import {ProfileDto} from '../../dtos/response/profile.dto';
import {ActivityCardComponent} from '../activity-card/activity-card.component';
import {ProfileHeaderComponent} from '../profile-header/profile-header.component';
import {Activity} from '../../models/activity.model';

/** Somebody's profile as a card: who they are, what they are doing, and since when. */
@Component({
    selector: 'app-profile-card',
    imports: [DatePipe, ActivityCardComponent, ProfileHeaderComponent],
    templateUrl: './profile-card.component.html',
})
export class ProfileCardComponent {
    readonly profile = input<ProfileDto | undefined>(undefined);
    readonly friendsSince = input<Date | null>(null);
    readonly avatarError = input(false);
    /** Rich presence for the subject. An input, not a store lookup, so this card stays injector-free. */
    readonly activities = input<Activity[]>([]);

    avatarClick = output<void>();
    avatarErrorChange = output<void>();
}
