import {ChangeDetectionStrategy, Component, computed, inject, input, output} from '@angular/core';
import {ProfileDto} from '../../dtos/response/profile.dto';
import {UserStatusDotComponent} from '../user-status-dot/user-status-dot.component';
import {UserNameStyleDirective} from '../../directives/user-name-style.directive';
import {safeAccentColor} from '../../models/profile-font.model';
import {cacheBustedUrl} from '../../models/profile-image.model';
import {BrokenImageService} from '../../services/broken-image.service';

/**
 * Who someone is: banner, avatar, status, name, bio.
 *
 * <p>Split out of {@link ProfileCardComponent} so the self menu in the bottom bar can reuse it. That
 * menu needs the identity block and then its own rows of actions — it has no use for the
 * biographical facts the card puts underneath, and "Friends Since" on your own profile is not a
 * fact at all. Extracting the shared half was the alternative to a second copy of the banner and
 * avatar overlap, which is the part with the fiddly geometry.</p>
 */
@Component({
    selector: 'app-profile-header',
    imports: [UserStatusDotComponent, UserNameStyleDirective],
    templateUrl: './profile-header.component.html',
    styleUrl: './profile-header.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileHeaderComponent {
    profile = input<ProfileDto | undefined>(undefined);
    avatarError = input(false);

    avatarClick = output<void>();
    avatarErrorChange = output<void>();

    protected readonly safeAccentColor = safeAccentColor;

    private readonly brokenImages = inject(BrokenImageService);

    /**
     * The banner to draw, or nothing - which leaves the accent colour showing.
     *
     * <p>A populated `bannerUrl` is not evidence of a banner: the API builds one for every profile
     * from its id, so the request 404s for anyone who never uploaded an image. Until it has been
     * tried the URL has to be treated as good, which is why the failure is remembered rather than
     * predicted.</p>
     */
    protected bannerUrl = computed((): string | undefined => {
        const profile = this.profile();
        const url = cacheBustedUrl(profile?.bannerUrl, profile?.updatedAt);
        return this.brokenImages.isBroken(url) ? undefined : url;
    });

    protected avatarLabel = computed(() =>
        this.profile()?.userName?.[0]?.toUpperCase() ?? '?'
    );

    protected onAvatarClick(): void {
        if (this.profile()?.avatarUrl && !this.avatarError()) {
            this.avatarClick.emit();
        }
    }

    protected onAvatarError(): void {
        this.avatarErrorChange.emit();
    }

    protected onBannerError(): void {
        this.brokenImages.markBroken(this.bannerUrl());
    }
}
