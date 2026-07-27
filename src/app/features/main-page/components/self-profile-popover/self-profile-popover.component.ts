import {Component, inject, output, signal, ViewChild} from '@angular/core';
import {Popover} from 'primeng/popover';
import {Button} from 'primeng/button';
import {ProfileService} from '../../../../services/profile.service';
import {ProfileCardComponent} from '../../../../components/profile-card/profile-card.component';
import {StatusPickerComponent} from '../status-picker/status-picker.component';

@Component({
    selector: 'app-self-profile-popover',
    imports: [Popover, Button, ProfileCardComponent, StatusPickerComponent],
    templateUrl: './self-profile-popover.component.html',
    styleUrl: './self-profile-popover.component.css',
})
export class SelfProfilePopoverComponent {
    editProfile = output<void>();
    protected profileService = inject(ProfileService);
    protected avatarError = signal(false);
    @ViewChild('popover') private popoverRef!: Popover;

    toggle(event: Event): void {
        this.popoverRef.toggle(event);
    }

    protected onEditProfile(): void {
        this.popoverRef.hide();
        this.editProfile.emit();
    }

    protected onAvatarError(): void {
        this.avatarError.set(true);
    }
}
