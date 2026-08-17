import {ChangeDetectionStrategy, Component, computed, inject, input, output, signal} from '@angular/core';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {ProfileDto} from '../../dtos/response/profile.dto';
import {ProfileService} from '../../services/profile.service';
import {RelationshipStore} from '../../stores/relationship.store';
import {ReportDialogService} from '../../services/report-dialog.service';
import {ToastService} from '../../services/toast.service';

/**
 * The overflow button on a profile surface: block, unblock, report. Shared so the popout and the
 * full modal cannot drift apart on what a profile lets you do.
 */
@Component({
    selector: 'app-profile-actions',
    imports: [TranslateModule],
    templateUrl: './profile-actions.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileActionsComponent {
    readonly profile = input<ProfileDto | undefined>(undefined);

    /** Raised when the action taken makes the surface meaningless to keep open. */
    readonly dismissed = output<void>();

    protected readonly menuOpen = signal(false);
    protected readonly confirmingBlock = signal(false);
    protected readonly pending = signal(false);

    private profileService = inject(ProfileService);
    private relationships = inject(RelationshipStore);
    private reportDialog = inject(ReportDialogService);
    private toast = inject(ToastService);
    private translate = inject(TranslateService);

    /** Blocking yourself is not a thing; the whole button is hidden on your own card. */
    protected readonly isSelf = computed(() => {
        const profile = this.profile();
        return !!profile && profile.userId === this.profileService.ownProfile()?.userId;
    });

    protected readonly isBlocked = computed(() => {
        const userId = this.profile()?.userId;
        return !!userId && this.relationships.blocked().some(r => r.other.userId === userId);
    });

    protected toggleMenu(event: MouseEvent): void {
        event.stopPropagation();
        this.menuOpen.update(open => !open);
    }

    protected closeMenu(): void {
        this.menuOpen.set(false);
    }

    /** Hands off to the report dialog. No subject id: `subjectKind: 'User'` takes none. */
    protected report(): void {
        const profile = this.profile();
        if (!profile) return;

        this.reportDialog.open({kind: 'User', targetUserId: profile.userId, targetName: profile.userName});
        this.menuOpen.set(false);
        this.dismissed.emit();
    }

    /** Blocking severs a friendship and is invisible to the other party, so it asks first. */
    protected askToBlock(): void {
        this.menuOpen.set(false);
        this.confirmingBlock.set(true);
    }

    protected cancelBlock(): void {
        this.confirmingBlock.set(false);
    }

    protected confirmBlock(): void {
        const profile = this.profile();
        if (!profile || this.pending()) return;
        this.pending.set(true);

        this.relationships.block(profile.userId).subscribe({
            next: () => {
                this.pending.set(false);
                this.confirmingBlock.set(false);
                this.toast.success(this.translate.instant('PROFILE.BLOCK_SUCCESS', {name: profile.userName}));
                this.dismissed.emit();
            },
            error: () => {
                this.pending.set(false);
                this.confirmingBlock.set(false);
                this.toast.error(this.translate.instant('PROFILE.BLOCK_ERROR'));
            },
        });
    }

    /** Unblocking is reversible, so it does not ask. */
    protected unblock(): void {
        const profile = this.profile();
        if (!profile || this.pending()) return;
        this.pending.set(true);
        this.menuOpen.set(false);

        this.relationships.unblock(profile.userId).subscribe({
            next: () => {
                this.pending.set(false);
                this.toast.success(
                    this.translate.instant('SETTINGS.PRIVACY.UNBLOCK_SUCCESS', {name: profile.userName}),
                );
            },
            error: () => {
                this.pending.set(false);
                this.toast.error(this.translate.instant('SETTINGS.PRIVACY.UNBLOCK_ERROR'));
            },
        });
    }
}
