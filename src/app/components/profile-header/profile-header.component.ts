import {ChangeDetectionStrategy, Component, computed, inject, input, output} from '@angular/core';
import {ProfileDto} from '../../dtos/response/profile.dto';
import {UserStatusDotComponent} from '../user-status-dot/user-status-dot.component';
import {UserNameStyleDirective} from '../../directives/user-name-style.directive';
import {safeAccentColor} from '../../models/profile-font.model';
import {cacheBustedUrl} from '../../models/profile-image.model';
import {BrokenImageService} from '../../services/broken-image.service';

/** Who someone is: banner, avatar, status, name, bio. Shared by {@link ProfileCardComponent} and the self menu. */
@Component({
    selector: 'app-profile-header',
    imports: [UserStatusDotComponent, UserNameStyleDirective],
    templateUrl: './profile-header.component.html',
    styleUrl: './profile-header.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileHeaderComponent {
    readonly profile = input<ProfileDto | undefined>(undefined);
    readonly avatarError = input(false);

    avatarClick = output<void>();
    avatarErrorChange = output<void>();

    protected readonly safeAccentColor = safeAccentColor;

    private readonly brokenImages = inject(BrokenImageService);

    /** The banner to draw, or nothing, which leaves the accent colour showing. A populated `bannerUrl` may still 404. */
    protected readonly bannerUrl = computed((): string | undefined => {
        const profile = this.profile();
        const url = cacheBustedUrl(profile?.bannerUrl, profile?.updatedAt);
        return this.brokenImages.isBroken(url) ? undefined : url;
    });

    protected readonly avatarLabel = computed(() =>
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
