import {ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked} from '@angular/core';
import {Router} from '@angular/router';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {ConfirmationService} from 'primeng/api';
import {ConfirmDialog} from 'primeng/confirmdialog';
import {finalize, forkJoin} from 'rxjs';
import {ProfileService} from '../../../services/profile.service';
import {CanvasEditorService} from '../../../services/canvas-editor.service';
import {ProfileEditDraftService} from '../../../services/profile-edit-draft.service';
import {ProfileCanvasStore} from '../../../stores/profile-canvas.store';
import {ToastService} from '../../../services/toast.service';
import {emptyCanvas} from '../../../models/profile-canvas';
import {ProfileMastheadComponent} from './profile-masthead.component';
import {ProfileCanvasEditorComponent} from './profile-canvas-editor.component';

/** Own-profile page: identity strip above the canvas, with an in-place edit mode. */
@Component({
    selector: 'app-profile-page',
    imports: [ProfileMastheadComponent, ProfileCanvasEditorComponent, TranslateModule, ConfirmDialog],
    templateUrl: './profile-page.component.html',
    providers: [ConfirmationService],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfilePageComponent {
    protected readonly profileService = inject(ProfileService);
    protected readonly canvasStore = inject(ProfileCanvasStore);
    protected readonly canvasEditor = inject(CanvasEditorService);
    protected readonly textDraft = inject(ProfileEditDraftService);

    private readonly router = inject(Router);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);
    private readonly confirmation = inject(ConfirmationService);

    protected readonly editing = signal(false);

    protected readonly uploadingAvatar = signal(false);
    protected readonly uploadingBanner = signal(false);

    protected readonly profile = computed(() => this.profileService.ownProfile());

    // Editing shows the arrangement being worked on, not the last saved one: a resize or a
    // property edit only mutates the draft, and the grid would look inert without this.
    protected readonly canvas = computed(() => {
        const profile = this.profile();
        if (!profile) return undefined;
        if (this.editing()) return this.canvasEditor.draft() ?? emptyCanvas(profile.id);
        return this.canvasStore.canvasFor(profile.id) ?? emptyCanvas(profile.id);
    });

    protected readonly dirty = computed(() => this.canvasEditor.dirty() || this.textDraft.dirty());

    // ownProfile is a fresh object on every own-profile write (updateProfile, uploadAvatar,
    // uploadBanner, setSelfStatus), not just when the signed-in profile changes, so this must key
    // on the id rather than the profile object or it re-begins and drops an unsaved canvas draft.
    private readonly profileId = computed(() => this.profile()?.id);

    constructor() {
        effect(() => {
            const id = this.profileId();
            if (!id) return;

            untracked(() => {
                const profile = this.profile();
                if (!profile) return;

                this.canvasStore.ensureLoaded(id);
                // Both drafts are root-provided and outlive this component, so a remount (leaving
                // the page and coming back) must not clobber a draft already in progress for the
                // same profile - only a genuinely different profile re-begins.
                if (this.canvasEditor.draft()?.profileId !== id) {
                    this.canvasEditor.begin(this.canvasStore.canvasFor(id) ?? emptyCanvas(id));
                }
                if (this.textDraft.draft()?.profileId !== id) {
                    this.textDraft.begin(profile);
                }
            });
        });
    }

    protected goBack(): void {
        void this.router.navigate(['/overview']);
    }

    protected startEdit(): void {
        this.editing.set(true);
    }

    protected cancel(): void {
        if (!this.dirty()) {
            this.editing.set(false);
            return;
        }

        this.confirmation.confirm({
            header: this.translate.instant('PROFILE_PAGE.CANCEL_CONFIRM_HEADER'),
            message: this.translate.instant('PROFILE_PAGE.CANCEL_CONFIRM_MESSAGE'),
            acceptLabel: this.translate.instant('PROFILE_PAGE.CANCEL_CONFIRM_ACCEPT'),
            rejectLabel: this.translate.instant('PROFILE_PAGE.CANCEL_CONFIRM_REJECT'),
            acceptButtonProps: {severity: 'danger', size: 'small'},
            rejectButtonProps: {severity: 'secondary', outlined: true, size: 'small'},
            accept: () => {
                this.canvasEditor.discard();
                this.textDraft.discard();
                this.editing.set(false);
            },
        });
    }

    protected save(): void {
        const canvas = this.canvasEditor.draft();
        const fields = this.textDraft.draft();
        if (!canvas || !fields || this.canvasStore.saving()) return;

        forkJoin([
            this.profileService.updateProfile({
                bio: fields.bio,
                accentColor: fields.accentColor,
                font: fields.font,
            }),
            this.canvasStore.save(canvas),
        ]).subscribe({
            next: ([profile, savedCanvas]) => {
                // Deliberate, not left to the mount effect: updateProfile() is exactly the write
                // that hands ownProfile a fresh object, and the effect only re-begins when the id
                // changes, so nothing else will clean these drafts.
                this.canvasEditor.begin(savedCanvas);
                this.textDraft.begin(profile);
                this.editing.set(false);
                this.toast.success(this.translate.instant('PROFILE_PAGE.SAVED'));
            },
            error: err => this.toast.httpError(this.translate.instant('PROFILE_PAGE.SAVE_FAILED'), err),
        });
    }

    protected onAvatarCropped(file: File): void {
        this.uploadingAvatar.set(true);
        this.profileService
            .uploadAvatar(file)
            .pipe(finalize(() => this.uploadingAvatar.set(false)))
            .subscribe({
                error: err =>
                    this.toast.httpError(this.translate.instant('PROFILE_PAGE.AVATAR_UPLOAD_FAILED'), err),
            });
    }

    protected onBannerCropped(file: File): void {
        this.uploadingBanner.set(true);
        this.profileService
            .uploadBanner(file)
            .pipe(finalize(() => this.uploadingBanner.set(false)))
            .subscribe({
                error: err =>
                    this.toast.httpError(this.translate.instant('PROFILE_PAGE.BANNER_UPLOAD_FAILED'), err),
            });
    }
}
