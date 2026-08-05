import {Component, input, output} from '@angular/core';
import {DatePipe} from '@angular/common';
import {ProfileDto} from '../../dtos/response/profile.dto';
import {ActivityCardComponent} from '../activity-card/activity-card.component';
import {ProfileHeaderComponent} from '../profile-header/profile-header.component';
import {Activity} from '../../models/activity.model';

/**
 * Somebody's profile as a card: who they are, what they are doing, and since when.
 *
 * <p>The identity half - banner, avatar, name, bio - lives in {@link ProfileHeaderComponent}, which
 * the bottom bar's self menu also uses. What stays here is the part only a full profile wants: live
 * activity, and the two dates underneath it.</p>
 */
@Component({
    selector: 'app-profile-card',
    imports: [DatePipe, ActivityCardComponent, ProfileHeaderComponent],
    templateUrl: './profile-card.component.html',
})
export class ProfileCardComponent {
    profile = input<ProfileDto | undefined>(undefined);
    friendsSince = input<Date | null>(null);
    avatarError = input(false);
    /**
     * Rich presence for the subject.
     *
     * <p>An input rather than a {@link UserActivityService} lookup, because everything else this
     * card renders is one too - it is handed its data and draws it, which is what makes it usable
     * from the profile dialog, the self popover and a test with no injector. Reaching into a store
     * here would drag `ProfileService`, `ApiConfigService` and `OAuthService` into the dependency
     * graph of a component that draws a banner.</p>
     */
    activities = input<Activity[]>([]);

    avatarClick = output<void>();
    avatarErrorChange = output<void>();
}
