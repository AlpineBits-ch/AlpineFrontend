import {ChangeDetectionStrategy, Component, computed, inject, output, signal} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {ProfileService} from '../../../../services/profile.service';
import {UserService} from '../../../../services/user.service';
import {UserType} from '../../../../dtos/response/UserDto';
import {OnlineStatus} from '../../../../dtos/response/profile.dto';
import {AccountRegistryService} from '../../../../services/account-registry.service';
import {ProfileHeaderComponent} from '../../../../components/profile-header/profile-header.component';
import {UserStatusDotComponent} from '../../../../components/user-status-dot/user-status-dot.component';
import {AccountSwitcherComponent} from '../account-switcher/account-switcher.component';
import {SELECTABLE_STATUSES, statusLabelKey} from '../../../../models/online-status.model';

/** Which face of the menu is showing. */
export type SelfMenuView = 'root' | 'status' | 'accounts';

/** You, and what you can do about being you. */
@Component({
    selector: 'app-self-profile-menu',
    imports: [TranslateModule, ProfileHeaderComponent, UserStatusDotComponent, AccountSwitcherComponent],
    templateUrl: './self-profile-menu.component.html',
    styleUrl: './self-profile-menu.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SelfProfileMenuComponent {
    editProfile = output<void>();
    openAdmin = output<void>();
    addAccount = output<void>();
    /** Raised after the body has been swapped, so the host can re-anchor its overlay. */
    viewChanged = output<void>();

    protected readonly profileService = inject(ProfileService);
    protected readonly userService = inject(UserService);

    protected readonly view = signal<SelfMenuView>('root');
    protected readonly avatarError = signal(false);

    protected readonly statuses = SELECTABLE_STATUSES;
    protected readonly statusLabelKey = statusLabelKey;

    protected readonly currentStatus = computed(() => this.profileService.ownProfile()?.onlineStatus ?? null);

    protected readonly isAdmin = computed(() => this.userService.self()?.userType === UserType.Admin);

    private readonly accounts = inject(AccountRegistryService);

    /** Whether there is anywhere to switch *to*. */
    protected readonly hasOtherAccounts = computed(() =>
        this.accounts.slots().some(slot => slot.id !== this.accounts.activeSlotIdSnapshot()),
    );

    /** Called by the host when the popover closes, so it never reopens mid-submenu. */
    reset(): void {
        this.view.set('root');
    }

    protected show(view: SelfMenuView): void {
        this.view.set(view);
        this.viewChanged.emit();
    }

    protected chooseStatus(status: OnlineStatus): void {
        this.profileService.setSelfStatus(status).subscribe();
        this.show('root');
    }

    protected onAvatarError(): void {
        this.avatarError.set(true);
    }
}
