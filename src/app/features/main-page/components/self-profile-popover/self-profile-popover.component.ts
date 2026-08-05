import {Component, inject, output, signal, ViewChild} from '@angular/core';
import {Popover} from 'primeng/popover';
import {Button} from 'primeng/button';
import {ProfileService} from '../../../../services/profile.service';
import {ProfileCardComponent} from '../../../../components/profile-card/profile-card.component';
import {StatusPickerComponent} from '../status-picker/status-picker.component';
import {AccountSwitcherComponent} from '../account-switcher/account-switcher.component';
import {UserActivityService} from '../../../../services/user-activity.service';

@Component({
    selector: 'app-self-profile-popover',
    imports: [Popover, Button, ProfileCardComponent, StatusPickerComponent, AccountSwitcherComponent],
    templateUrl: './self-profile-popover.component.html',
    styleUrl: './self-profile-popover.component.css',
})
export class SelfProfilePopoverComponent {
    editProfile = output<void>();
    /** Asked for here, routed by the host - this popover owns no navigation. */
    addAccount = output<void>();
    protected profileService = inject(ProfileService);
    protected userActivity = inject(UserActivityService);
    protected avatarError = signal(false);
    @ViewChild('popover') private popoverRef!: Popover;

    toggle(event: Event): void {
        this.popoverRef.toggle(event);
    }

    protected onEditProfile(): void {
        this.popoverRef.hide();
        this.editProfile.emit();
    }

    protected onAddAccount(): void {
        this.popoverRef.hide();
        this.addAccount.emit();
    }

    protected onAvatarError(): void {
        this.avatarError.set(true);
    }
}
