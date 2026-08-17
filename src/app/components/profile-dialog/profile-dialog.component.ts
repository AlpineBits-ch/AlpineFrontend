import {
    Component,
    computed,
    EventEmitter,
    inject,
    Input,
    OnChanges,
    Output,
    signal,
    SimpleChanges
} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {ProfileDto} from '../../dtos/response/profile.dto';
import {ProfileService} from '../../services/profile.service';
import {ProfileCardComponent} from '../profile-card/profile-card.component';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {RelationshipStore} from '../../stores/relationship.store';
import {ToastService} from '../../services/toast.service';
import {UserActivityService} from '../../services/user-activity.service';
import {ReportDialogService} from '../../services/report-dialog.service';

@Component({
    selector: 'app-profile-dialog',
    standalone: true,
    imports: [Dialog, Button, ProfileCardComponent, TranslateModule],
    templateUrl: './profile-dialog.component.html',
    styleUrl: './profile-dialog.component.css',
})
export class ProfileDialogComponent implements OnChanges {
    @Input() userId: string | null = null;
    @Input() friendsSince: Date | null = null;
    @Output() visibleChange = new EventEmitter<boolean>();
    protected dialogVisible = false;
    protected readonly profile = signal<ProfileDto | undefined>(undefined);
    protected avatarExpanded = false;
    protected readonly avatarError = signal(false);
    protected readonly blockConfirmVisible = signal(false);
    protected readonly blockPending = signal(false);
    private profileService = inject(ProfileService);
    private relationships = inject(RelationshipStore);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);
    private userActivity = inject(UserActivityService);
    private reportDialog = inject(ReportDialogService);

    /** Rich presence for whoever the card is showing. Resolved here so the card stays injector-free. */
    protected readonly activities = computed(() =>
        this.userActivity.activitiesFor(this.profile()?.userId)
    );

    /** Blocking yourself is not a thing; the action is hidden on your own card. */
    protected readonly isSelf = computed(() => {
        const profile = this.profile();
        return !!profile && profile.userId === this.profileService.ownProfile()?.userId;
    });

    protected readonly isBlocked = computed(() => {
        const userId = this.profile()?.userId;
        return !!userId && this.relationships.blocked().some(r => r.other.userId === userId);
    });

    ngOnChanges(changes: SimpleChanges): void {
        if (changes['userId']) {
            const id = this.userId;
            if (id) {
                this.dialogVisible = true;
                this.avatarError.set(false);
                const cached = this.profileService.getCachedByUserId(id);
                if (cached) {
                    this.profile.set(cached);
                } else {
                    this.profile.set(undefined);
                    this.profileService.getByUserId(id).subscribe(p => this.profile.set(p));
                }
            } else {
                this.dialogVisible = false;
                this.profile.set(undefined);
                this.avatarExpanded = false;
                this.avatarError.set(false);
                this.blockConfirmVisible.set(false);
            }
        }
    }

    protected onHide(): void {
        this.visibleChange.emit(false);
    }

    /** Hands off to the report dialog and closes this one. No subject id: `subjectKind: 'User'` takes none. */
    protected report(): void {
        const profile = this.profile();
        if (!profile) return;

        this.reportDialog.open({
            kind: 'User',
            targetUserId: profile.userId,
            targetName: profile.userName,
        });
        this.dialogVisible = false;
        this.visibleChange.emit(false);
    }

    protected onAvatarClick(): void {
        if (this.profile()?.avatarUrl && !this.avatarError()) {
            this.avatarExpanded = true;
        }
    }

    protected onAvatarError(): void {
        this.avatarError.set(true);
    }

    /** Blocking severs a friendship, so it asks first. Unblocking is reversible and does not. */
    protected askToBlock(): void {
        this.blockConfirmVisible.set(true);
    }

    protected confirmBlock(): void {
        const profile = this.profile();
        if (!profile || this.blockPending()) return;
        this.blockPending.set(true);

        this.relationships.block(profile.userId).subscribe({
            next: () => {
                this.blockPending.set(false);
                this.blockConfirmVisible.set(false);
                this.dialogVisible = false;
                this.visibleChange.emit(false);
                this.toast.success(
                    this.translate.instant('PROFILE.BLOCK_SUCCESS', {name: profile.userName}),
                );
            },
            error: () => {
                this.blockPending.set(false);
                this.blockConfirmVisible.set(false);
                this.toast.error(this.translate.instant('PROFILE.BLOCK_ERROR'));
            },
        });
    }

    protected unblock(): void {
        const profile = this.profile();
        if (!profile || this.blockPending()) return;
        this.blockPending.set(true);

        this.relationships.unblock(profile.userId).subscribe({
            next: () => {
                this.blockPending.set(false);
                this.toast.success(
                    this.translate.instant('SETTINGS.PRIVACY.UNBLOCK_SUCCESS', {name: profile.userName}),
                );
            },
            error: () => {
                this.blockPending.set(false);
                this.toast.error(this.translate.instant('SETTINGS.PRIVACY.UNBLOCK_ERROR'));
            },
        });
    }
}
