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

/**
 * You, and what you can do about being you.
 *
 * <p>Grouped rows on their own raised card rather than a flat list, which is what makes a menu read
 * as a menu and not as the bottom of the profile above it.</p>
 *
 * <p><b>Submenus are a view swap inside this component, not nested overlays.</b> The popover hosting
 * it is `appendTo="body"`, and a `p-menu` opened from inside one fights it for both stacking order
 * and outside-click dismissal — the second overlay closes the first. Swapping the body sidesteps
 * that entirely and is also what the reference design does.</p>
 *
 * <p>It opens no modals of its own. The settings and admin dialogs are owned by the quick-settings
 * footer, which holds the `@ViewChild` and the titlebar effect that drive them, so this emits and
 * lets the host decide.</p>
 */
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
    /**
     * Raised after the body has been swapped, so the host can re-anchor its overlay.
     *
     * <p>The three views are different heights and the popover opens upward from the footer. PrimeNG
     * positions the overlay once, on open, from the height it had then - so a shorter view leaves
     * the popover floating well above the bar it is supposed to be attached to.</p>
     */
    viewChanged = output<void>();

    protected readonly profileService = inject(ProfileService);
    protected readonly userService = inject(UserService);

    protected readonly view = signal<SelfMenuView>('root');
    protected readonly avatarError = signal(false);

    protected readonly statuses = SELECTABLE_STATUSES;
    protected readonly statusLabelKey = statusLabelKey;

    protected readonly currentStatus = computed(() =>
        this.profileService.ownProfile()?.onlineStatus ?? null
    );

    protected readonly isAdmin = computed(() =>
        this.userService.self()?.userType === UserType.Admin
    );

    private readonly accounts = inject(AccountRegistryService);

    /**
     * Whether there is anywhere to switch *to*.
     *
     * <p>With one account the row would open a submenu holding a single "Add Account" button, so the
     * root offers that button directly instead. Every installation is in this state until it adds a
     * second account, which makes it the common case rather than the edge one.</p>
     */
    protected readonly hasOtherAccounts = computed(() =>
        this.accounts.slots().some(slot => slot.id !== this.accounts.activeSlotIdSnapshot())
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
