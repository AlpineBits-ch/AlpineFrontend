import {
    ChangeDetectionStrategy,
    Component,
    computed,
    ElementRef,
    effect,
    inject,
    signal,
    untracked,
    viewChild,
} from '@angular/core';
import {Router} from '@angular/router';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {ConfirmationService} from 'primeng/api';
import {ConfirmDialog} from 'primeng/confirmdialog';
import {Dialog} from 'primeng/dialog';
import {ColorPicker} from 'primeng/colorpicker';
import {finalize, forkJoin} from 'rxjs';
import {AppAvatarComponent} from '../../../components/avatar/avatar.component';
import {ImageCropperComponent} from '../../../components/image-cropper/image-cropper.component';
import {ProfileCanvasComponent} from '../../../components/profile-canvas/profile-canvas.component';
import {ProfileService} from '../../../services/profile.service';
import {CanvasEditorService} from '../../../services/canvas-editor.service';
import {ProfileEditDraftService} from '../../../services/profile-edit-draft.service';
import {ProfileCanvasStore} from '../../../stores/profile-canvas.store';
import {ToastService} from '../../../services/toast.service';
import {FONT_LABELS, safeAccentColor} from '../../../models/profile-font.model';
import {cacheBustedUrl} from '../../../models/profile-image.model';
import {emptyCanvas} from '../../../models/profile-canvas';
import {ProfileFont} from '../../../dtos/response/profile.dto';

/** Own-profile page: identity strip above the canvas, with an in-place edit mode. */
@Component({
    selector: 'app-profile-page',
    imports: [
        AppAvatarComponent,
        ProfileCanvasComponent,
        TranslateModule,
        FormsModule,
        ConfirmDialog,
        Dialog,
        ImageCropperComponent,
        ColorPicker,
    ],
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

    protected readonly avatarCropVisible = signal(false);
    protected readonly avatarCropSrc = signal('');
    protected readonly uploadingAvatar = signal(false);

    protected readonly bannerCropVisible = signal(false);
    protected readonly bannerCropSrc = signal('');
    protected readonly uploadingBanner = signal(false);

    private readonly avatarFileInputRef = viewChild<ElementRef<HTMLInputElement>>('avatarFileInput');
    private readonly bannerFileInputRef = viewChild<ElementRef<HTMLInputElement>>('bannerFileInput');

    protected readonly profile = computed(() => this.profileService.ownProfile());

    protected readonly bannerUrl = computed((): string | undefined => {
        const profile = this.profile();
        return cacheBustedUrl(profile?.bannerUrl, profile?.updatedAt);
    });

    protected readonly bannerFallback = computed(() => safeAccentColor(this.profile()?.accentColor));

    protected readonly canvas = computed(() => {
        const profile = this.profile();
        return profile ? (this.canvasStore.canvasFor(profile.id) ?? emptyCanvas(profile.id)) : undefined;
    });

    /** p-colorpicker's hex format has no leading `#`; the draft and the DTO both do. */
    protected readonly accentColorHex = computed(() =>
        (this.textDraft.draft()?.accentColor ?? '').replace('#', ''),
    );

    protected readonly dirty = computed(() => this.canvasEditor.dirty() || this.textDraft.dirty());

    protected get fontOptions(): {value: ProfileFont; label: string}[] {
        // A getter, not a field: an imported const read as a class field is undefined under Vite.
        return (Object.entries(FONT_LABELS) as [ProfileFont, string][]).map(([value, label]) => ({
            value,
            label,
        }));
    }

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

    protected onAccentChange(hex: string): void {
        this.textDraft.setAccentColor(hex ? `#${hex}` : '');
    }

    protected pickAvatarFile(): void {
        this.avatarFileInputRef()?.nativeElement.click();
    }

    protected onAvatarFileSelected(event: Event): void {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => {
            this.avatarCropSrc.set(reader.result as string);
            this.avatarCropVisible.set(true);
        };
        reader.readAsDataURL(file);
    }

    protected onAvatarCropConfirmed(file: File): void {
        this.avatarCropVisible.set(false);
        this.uploadingAvatar.set(true);
        this.profileService
            .uploadAvatar(file)
            .pipe(finalize(() => this.uploadingAvatar.set(false)))
            .subscribe({
                error: err =>
                    this.toast.httpError(this.translate.instant('PROFILE_PAGE.AVATAR_UPLOAD_FAILED'), err),
            });
    }

    protected pickBannerFile(): void {
        this.bannerFileInputRef()?.nativeElement.click();
    }

    protected onBannerFileSelected(event: Event): void {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;

        const reader = new FileReader();
        reader.onload = () => {
            this.bannerCropSrc.set(reader.result as string);
            this.bannerCropVisible.set(true);
        };
        reader.readAsDataURL(file);
    }

    protected onBannerCropConfirmed(file: File): void {
        this.bannerCropVisible.set(false);
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
