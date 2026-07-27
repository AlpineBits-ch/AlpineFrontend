import {Component, inject} from '@angular/core';
import {Menu} from 'primeng/menu';
import {MenuItem} from 'primeng/api';
import {ProfileService} from '../../../../services/profile.service';
import {OnlineStatus} from '../../../../dtos/response/profile.dto';
import {UserStatusDotComponent} from '../../../../components/user-status-dot/user-status-dot.component';

@Component({
    selector: 'app-status-picker',
    imports: [Menu, UserStatusDotComponent],
    templateUrl: './status-picker.component.html',
})
export class StatusPickerComponent {
    protected profileService = inject(ProfileService);
    protected readonly OnlineStatus = OnlineStatus;

    protected menuItems: MenuItem[] = [
        {label: 'Online', icon: 'pi pi-circle-fill', styleClass: 'status-online', command: () => this.setStatus(OnlineStatus.Online)},
        {label: 'Idle', icon: 'pi pi-circle-fill', styleClass: 'status-idle', command: () => this.setStatus(OnlineStatus.Idle)},
        {label: 'Do Not Disturb', icon: 'pi pi-circle-fill', styleClass: 'status-dnd', command: () => this.setStatus(OnlineStatus.DoNotDisturb)},
        {label: 'Appear Offline', icon: 'pi pi-circle', styleClass: 'status-hidden', command: () => this.setStatus(OnlineStatus.Hidden)},
    ];

    private setStatus(status: OnlineStatus): void {
        this.profileService.setSelfStatus(status).subscribe();
    }
}
