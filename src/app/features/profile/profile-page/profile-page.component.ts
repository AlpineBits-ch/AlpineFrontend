import {ChangeDetectionStrategy, Component, computed, inject} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {AppAvatarComponent} from '../../../components/avatar/avatar.component';
import {ProfileService} from '../../../services/profile.service';
import {safeAccentColor} from '../../../models/profile-font.model';
import {cacheBustedUrl} from '../../../models/profile-image.model';

/** Own-profile page shell. Task 3 fills in pronouns, bio and the canvas. */
@Component({
    selector: 'app-profile-page',
    imports: [AppAvatarComponent, TranslateModule],
    templateUrl: './profile-page.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfilePageComponent {
    protected readonly profileService = inject(ProfileService);
    protected readonly profile = computed(() => this.profileService.ownProfile());

    protected readonly bannerUrl = computed((): string | undefined => {
        const profile = this.profile();
        return cacheBustedUrl(profile?.bannerUrl, profile?.updatedAt);
    });

    protected readonly bannerFallback = computed(() => safeAccentColor(this.profile()?.accentColor));
}
