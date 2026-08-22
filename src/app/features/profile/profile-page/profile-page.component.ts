import {
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    effect,
    inject,
    signal,
    untracked,
} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {Router} from '@angular/router';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {ConfirmationService} from 'primeng/api';
import {ConfirmDialog} from 'primeng/confirmdialog';
import {debounceTime, finalize, Subject} from 'rxjs';
import {ProfileService} from '../../../services/profile.service';
import {CanvasEditorService} from '../../../services/canvas-editor.service';
import {ProfileEditDraftService} from '../../../services/profile-edit-draft.service';
import {ProfileCanvasStore} from '../../../stores/profile-canvas.store';
import {ToastService} from '../../../services/toast.service';
import {emptyCanvas} from '../../../models/profile-canvas';
import {ProfileCanvasDto} from '../../../dtos/response/profile-canvas.dto';
import {ProfileFont} from '../../../dtos/response/profile.dto';
import {AUTOSAVE_DEBOUNCE_MS} from '../../discovery/listing-editor/listing-editor.component';
import {ProfileMastheadComponent} from './profile-masthead.component';
import {ProfileCanvasEditorComponent} from './profile-canvas-editor.component';

/** Own-profile page: identity strip above the canvas, always editable, autosaved. */
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

    protected readonly uploadingAvatar = signal(false);
    protected readonly uploadingBanner = signal(false);

    /** Reflects both the bio/accent/font autosave and the canvas autosave; whichever last moved. */
    protected readonly saveStatus = signal<'saved' | 'unsaved' | 'saving' | 'error'>('saved');

    protected readonly profile = computed(() => this.profileService.ownProfile());

    protected readonly canvas = computed((): ProfileCanvasDto | undefined => {
        const profile = this.profile();
        if (!profile) return undefined;
        return this.canvasEditor.draft() ?? this.canvasStore.canvasFor(profile.id) ?? emptyCanvas(profile.id);
    });

    // ownProfile is a fresh object on every own-profile write (updateProfile, uploadAvatar,
    // uploadBanner, setSelfStatus), not just when the signed-in profile changes, so this must key
    // on the id rather than the profile object or it re-begins and drops an unsaved canvas draft.
    private readonly profileId = computed(() => this.profile()?.id);

    private readonly textAutosave$ = new Subject<void>();

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

        this.textAutosave$
            .pipe(debounceTime(AUTOSAVE_DEBOUNCE_MS), takeUntilDestroyed())
            .subscribe(() => this.flushText());

        // Canvas edits write on their own rather than coalescing: draft() is a fresh object on
        // every mutation, so this reruns per edit. The store's own saving flag is the only guard
        // needed - it stops a second request going out while one is in flight, and this effect
        // fires again once it clears, picking up whatever landed meanwhile.
        effect(() => {
            const canvas = this.canvasEditor.draft();
            const dirty = this.canvasEditor.dirty();
            const saving = this.canvasStore.saving();
            if (canvas && dirty && !saving) untracked(() => this.saveCanvasNow(canvas));
        });

        // The debounce above never fires for the last edit before navigating away, and Back is
        // this page's primary exit.
        inject(DestroyRef).onDestroy(() => {
            if (this.textDraft.dirty()) this.flushText();
            const canvas = this.canvasEditor.draft();
            if (canvas && this.canvasEditor.dirty() && !this.canvasStore.saving()) this.saveCanvasNow(canvas);
        });
    }

    protected goBack(): void {
        void this.router.navigate(['/overview']);
    }

    protected setBio(bio: string): void {
        this.textDraft.setBio(bio);
        this.queueTextAutosave();
    }

    protected setAccentColor(accentColor: string): void {
        this.textDraft.setAccentColor(accentColor);
        this.queueTextAutosave();
    }

    protected setFont(font: ProfileFont): void {
        this.textDraft.setFont(font);
        this.queueTextAutosave();
    }

    private queueTextAutosave(): void {
        this.saveStatus.set('unsaved');
        this.textAutosave$.next();
    }

    private flushText(): void {
        const fields = this.textDraft.draft();
        if (!fields) return;

        this.saveStatus.set('saving');
        this.profileService
            .updateProfile({bio: fields.bio, accentColor: fields.accentColor, font: fields.font})
            .subscribe({
                next: profile => {
                    // A newer edit may have landed while this was in flight; only re-baseline
                    // when nothing has, or begin() would silently discard it.
                    if (this.textDraft.draft() === fields) this.textDraft.begin(profile);
                    this.saveStatus.set('saved');
                },
                error: () => this.saveStatus.set('error'),
            });
    }

    private saveCanvasNow(canvas: ProfileCanvasDto): void {
        this.saveStatus.set('saving');
        this.canvasStore.save(canvas).subscribe({
            next: saved => {
                // Same race as flushText(): a later edit may already have moved the draft on.
                if (this.canvasEditor.draft() === canvas) this.canvasEditor.begin(saved);
                this.saveStatus.set('saved');
            },
            error: () => this.saveStatus.set('error'),
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

    protected onAvatarRemoveRequested(): void {
        this.confirmation.confirm({
            header: this.translate.instant('PROFILE_PAGE.REMOVE_AVATAR_CONFIRM_HEADER'),
            message: this.translate.instant('PROFILE_PAGE.REMOVE_AVATAR_CONFIRM_MESSAGE'),
            acceptLabel: this.translate.instant('PROFILE_PAGE.REMOVE_AVATAR_CONFIRM_ACCEPT'),
            rejectLabel: this.translate.instant('PROFILE_PAGE.REMOVE_AVATAR_CONFIRM_REJECT'),
            acceptButtonProps: {severity: 'danger', size: 'small'},
            rejectButtonProps: {severity: 'secondary', outlined: true, size: 'small'},
            accept: () => this.profileService.removeAvatar().subscribe(),
        });
    }
}
