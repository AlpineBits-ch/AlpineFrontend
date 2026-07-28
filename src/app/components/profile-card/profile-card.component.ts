import {Component, computed, input, output} from '@angular/core';
import {DatePipe} from '@angular/common';
import {ProfileDto} from '../../dtos/response/profile.dto';
import {UserStatusDotComponent} from '../user-status-dot/user-status-dot.component';
import {UserNameStyleDirective} from '../../directives/user-name-style.directive';
import {safeAccentColor} from '../../models/profile-font.model';
import {cacheBustedUrl} from '../../models/profile-image.model';

@Component({
    selector: 'app-profile-card',
    imports: [DatePipe, UserStatusDotComponent, UserNameStyleDirective],
    templateUrl: './profile-card.component.html',
    styleUrl: './profile-card.component.css',
})
export class ProfileCardComponent {
    profile = input<ProfileDto | undefined>(undefined);
    friendsSince = input<Date | null>(null);
    avatarError = input(false);

    avatarClick = output<void>();
    avatarErrorChange = output<void>();

    protected readonly safeAccentColor = safeAccentColor;
    protected readonly cacheBustedUrl = cacheBustedUrl;

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
}
