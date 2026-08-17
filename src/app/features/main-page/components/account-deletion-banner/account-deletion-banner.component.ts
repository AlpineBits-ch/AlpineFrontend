import {Component, computed, EventEmitter, inject, Output} from '@angular/core';
import {DatePipe} from '@angular/common';
import {UserService} from '../../../../services/user.service';
import {AccountStatus} from '../../../../dtos/response/UserDto';

@Component({
    selector: 'app-account-deletion-banner',
    imports: [DatePipe],
    templateUrl: './account-deletion-banner.component.html',
})
export class AccountDeletionBannerComponent {
    protected userService = inject(UserService);
    @Output() manage = new EventEmitter<void>();

    protected readonly visible = computed(
        () => this.userService.self()?.status === AccountStatus.PendingDeletion,
    );
    protected readonly purgeScheduledAt = computed(() => this.userService.self()?.purgeScheduledAt);
}
