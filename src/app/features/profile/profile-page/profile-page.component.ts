import {
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    effect,
    HostListener,
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
import {
    CanvasHistoryKind,
    ProfileEditHistoryService,
    ProfileHistoryEntry,
} from '../../../services/profile-edit-history.service';
import {ProfileCanvasStore} from '../../../stores/profile-canvas.store';
import {ToastService} from '../../../services/toast.service';
import {emptyCanvas} from '../../../models/profile-canvas';
import {definitionFor} from '../../../components/profile-canvas/widget-registry';
import {ProfileCanvasDto} from '../../../dtos/response/profile-canvas.dto';
import {ProfileFont} from '../../../dtos/response/profile.dto';
import {AUTOSAVE_DEBOUNCE_MS} from '../../discovery/listing-editor/listing-editor.component';
import {ProfileMastheadComponent} from './profile-masthead.component';
import {ProfileCanvasEditorComponent} from './profile-canvas-editor.component';

/** Keyed on `TextHistoryKind`; what to call the field in an undo/redo label. */
const TEXT_ACTION_KEYS: Record<'bio' | 'accentColor' | 'font', string> = {
    bio: 'PROFILE_PAGE.UNDO_ACTION.BIO',
    accentColor: 'PROFILE_PAGE.UNDO_ACTION.ACCENT_COLOR',
    font: 'PROFILE_PAGE.UNDO_ACTION.FONT',
};

/** Keyed on `CanvasHistoryKind`; takes `{type}`, the widget's translated label. */
const CANVAS_ACTION_KEYS: Record<CanvasHistoryKind, string> = {
    add: 'PROFILE_PAGE.UNDO_ACTION.ADD',
    remove: 'PROFILE_PAGE.UNDO_ACTION.REMOVE',
    move: 'PROFILE_PAGE.UNDO_ACTION.MOVE',
    resize: 'PROFILE_PAGE.UNDO_ACTION.RESIZE',
    visibility: 'PROFILE_PAGE.UNDO_ACTION.VISIBILITY',
    card: 'PROFILE_PAGE.UNDO_ACTION.CARD',
    config: 'PROFILE_PAGE.UNDO_ACTION.CONFIG',
};

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
    protected readonly history = inject(ProfileEditHistoryService);

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
    private readonly textSaving = signal(false);
    /** Widgets JSON of the canvas save that last failed; cleared by a save that reaches a
     * genuinely different state, whether that is a fresh edit or an undo. Prevents the autosave
     * effect from re-firing on the same rejected payload at network-round-trip cadence. */
    private readonly canvasSaveFailedFor = signal<string | null>(null);

    protected readonly canUndo = computed(() => this.history.canUndo());
    protected readonly canRedo = computed(() => this.history.canRedo());
    protected readonly undoLabel = computed(() => this.describeHistoryEntry(this.history.nextUndo()));
    protected readonly redoLabel = computed(() => this.describeHistoryEntry(this.history.nextRedo()));

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

        this.textAutosave$.pipe(debounceTime(AUTOSAVE_DEBOUNCE_MS), takeUntilDestroyed()).subscribe(() => {
            this.commitTextHistory();
            this.flushText();
        });

        // Canvas edits write on their own rather than coalescing: draft() is a fresh object on
        // every mutation, so this reruns per edit. The store's own saving flag stops a second
        // request going out while one is in flight; canvasSaveFailedFor stops it retrying a
        // rejected payload once saving() drops back to false, which the store does on every
        // exit path including a failed one.
        effect(() => {
            const canvas = this.canvasEditor.draft();
            const dirty = this.canvasEditor.dirty();
            const saving = this.canvasStore.saving();
            if (!canvas || !dirty || saving) return;
            if (this.canvasSaveFailedFor() === JSON.stringify(canvas.widgets)) return;
            untracked(() => this.saveCanvasNow(canvas));
        });

        // The debounce above never fires for the last edit before navigating away, and Back is
        // this page's primary exit. Both branches guard on their own in-flight flag, or a
        // request already sent but not yet answered would go out a second time.
        inject(DestroyRef).onDestroy(() => {
            if (this.textDraft.dirty() && !this.textSaving()) {
                this.commitTextHistory();
                this.flushText();
            }
            const canvas = this.canvasEditor.draft();
            if (canvas && this.canvasEditor.dirty() && !this.canvasStore.saving()) this.saveCanvasNow(canvas);
            // Undo does not survive leaving the page.
            this.history.reset();
        });
    }

    protected goBack(): void {
        void this.router.navigate(['/overview']);
    }

    protected setBio(bio: string): void {
        this.history.noteTextField('bio', this.textDraft.draft()?.bio ?? '');
        this.textDraft.setBio(bio);
        this.queueTextAutosave();
    }

    protected setAccentColor(accentColor: string): void {
        this.history.noteTextField('accentColor', this.textDraft.draft()?.accentColor ?? '');
        this.textDraft.setAccentColor(accentColor);
        this.queueTextAutosave();
    }

    protected setFont(font: ProfileFont): void {
        this.history.noteTextField('font', this.textDraft.draft()?.font ?? ProfileFont.Default);
        this.textDraft.setFont(font);
        this.queueTextAutosave();
    }

    /** Ctrl+Z / Ctrl+Shift+Z. Skipped inside a text field, where the browser's own text undo owns the key. */
    @HostListener('document:keydown', ['$event'])
    protected onKeydown(event: KeyboardEvent): void {
        if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;
        const target = event.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
            return;
        }
        event.preventDefault();
        if (event.shiftKey) this.redo();
        else this.undo();
    }

    protected undo(): void {
        const entry = this.history.undo();
        if (entry) this.applyHistoryEntry(entry, 'before');
    }

    protected redo(): void {
        const entry = this.history.redo();
        if (entry) this.applyHistoryEntry(entry, 'after');
    }

    /** Undo and redo both land through the normal setters, so an undone change autosaves like
     * any other edit rather than needing a second write path. */
    private applyHistoryEntry(entry: ProfileHistoryEntry, direction: 'before' | 'after'): void {
        if (entry.domain === 'canvas') {
            this.canvasEditor.restore(entry[direction]);
            return;
        }
        const value = entry[direction];
        if (entry.kind === 'bio') this.textDraft.setBio(value as string);
        else if (entry.kind === 'accentColor') this.textDraft.setAccentColor(value as string);
        else this.textDraft.setFont(value as ProfileFont);
        this.queueTextAutosave();
    }

    private describeHistoryEntry(entry: ProfileHistoryEntry | null): string {
        if (!entry) return '';
        if (entry.domain === 'text') return this.translate.instant(TEXT_ACTION_KEYS[entry.kind]);
        const type = this.translate.instant(definitionFor(entry.widgetType)?.labelKey ?? '');
        return this.translate.instant(CANVAS_ACTION_KEYS[entry.kind], {type});
    }

    private queueTextAutosave(): void {
        this.saveStatus.set('unsaved');
        this.textAutosave$.next();
    }

    private commitTextHistory(): void {
        const fields = this.textDraft.draft();
        if (fields) this.history.commitText(fields);
    }

    private flushText(): void {
        const fields = this.textDraft.draft();
        if (!fields) return;

        this.saveStatus.set('saving');
        this.textSaving.set(true);
        this.profileService
            .updateProfile({bio: fields.bio, accentColor: fields.accentColor, font: fields.font})
            .subscribe({
                next: profile => {
                    // A newer edit may have landed while this was in flight; only re-baseline
                    // when nothing has, or begin() would silently discard it.
                    if (this.textDraft.draft() === fields) this.textDraft.begin(profile);
                    this.saveStatus.set('saved');
                    this.textSaving.set(false);
                },
                error: err => {
                    this.saveStatus.set('error');
                    this.textSaving.set(false);
                    this.toast.httpError(this.translate.instant('PROFILE_PAGE.SAVE_ERROR'), err);
                },
            });
    }

    private saveCanvasNow(canvas: ProfileCanvasDto): void {
        this.saveStatus.set('saving');
        this.canvasStore.save(canvas).subscribe({
            next: saved => {
                // Same race as flushText(): a later edit may already have moved the draft on.
                if (this.canvasEditor.draft() === canvas) this.canvasEditor.begin(saved);
                this.canvasSaveFailedFor.set(null);
                this.saveStatus.set('saved');
            },
            error: err => {
                this.canvasSaveFailedFor.set(JSON.stringify(canvas.widgets));
                this.saveStatus.set('error');
                this.toast.httpError(this.translate.instant('PROFILE_PAGE.SAVE_ERROR'), err);
            },
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
