import {
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    effect,
    inject,
    input,
    output,
    signal,
    untracked,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {HttpErrorResponse} from '@angular/common/http';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {catchError, forkJoin, map, Observable, of, switchMap} from 'rxjs';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PrimeTemplate} from 'primeng/api';
import {ImageCropperComponent} from '../../../../components/image-cropper/image-cropper.component';
import {PersonaAvatarComponent} from '../persona-avatar/persona-avatar.component';
import {PersonaService} from '../../../../services/persona.service';
import {ToastService} from '../../../../services/toast.service';
import {GuildPersonaDto, PersonaDto} from '../../../../dtos/response/persona.dto';
import {safeAccentColor} from '../../../../models/profile-font.model';
import {apiErrorMessage} from '../../../../core/api-error';
import {findTagCollision, formatProxyTags, proxyTagsOf} from '../persona-proxy';
import {ARCHIVE_COLOR_FALLBACK, ARCHIVE_COLORS} from '../../scenes/scene-archive/archive-colors';

/** Which of the two avatars a pick, a crop or a clear is aimed at. */
type AvatarHalf = 'global' | 'guild';

/**
 * The picked file, before cropping. The crop output is a 400x400 PNG whatever goes in, so this only
 * has to stop a phone photo being read into a data URL and freezing the dialog.
 */
const MAX_PICK_MB = 8;
const MAX_PICK_BYTES = MAX_PICK_MB * 1024 * 1024;

/** What the dialog was opened to do. */
export interface PersonaEditorTarget {
    /** Absent when creating. */
    persona: PersonaDto | null;
    /** Absent when editing the account-level row with no guild in view. */
    entry: GuildPersonaDto | null;
    /** Set when the guild half should be shown and saved. */
    guildId: string | null;
    /** Creates `Scope = Guild` instead of a personal character. */
    guildOwned?: boolean;
}

/**
 * One form for both halves of a character: the row that follows the account everywhere, and this
 * guild's overrides on top of it. Shown side by side because the split is the thing people get
 * wrong, and a tab would hide half the answer.
 */
@Component({
    selector: 'app-persona-editor',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        Dialog,
        Button,
        PrimeTemplate,
        FormsModule,
        TranslateModule,
        PersonaAvatarComponent,
        ImageCropperComponent,
    ],
    templateUrl: './persona-editor.component.html',
    styleUrl: './persona-editor.component.css',
})
export class PersonaEditorComponent {
    readonly target = input<PersonaEditorTarget | null>(null);
    readonly guildName = input<string>('');

    readonly closed = output<void>();
    readonly saved = output<void>();

    private readonly personas = inject(PersonaService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);

    protected readonly saving = signal(false);
    /** What the server said when it refused the save as a clash. Empty means no refusal in hand. */
    protected readonly conflict = signal('');

    // Global half.
    protected readonly name = signal('');
    protected readonly avatarUrl = signal('');
    protected readonly pronouns = signal('');
    protected readonly color = signal('');
    protected readonly shortBio = signal('');

    // Guild half. Empty means "use the global answer", which is what the placeholders show.
    protected readonly displayName = signal('');
    protected readonly guildAvatarUrl = signal('');
    protected readonly tag = signal('');
    protected readonly proxyPrefix = signal('');
    protected readonly proxySuffix = signal('');

    /**
     * The two avatar URL signals hold what the server has stored and are never written by the
     * picker: the save echoes them back unchanged and lets the upload and delete routes do every
     * avatar write. Sending null in the body instead would clear the column, and the delete route
     * then sees nothing to remove and leaves the bytes in storage.
     */
    private readonly pending: Record<AvatarHalf, ReturnType<typeof signal<File | null>>> = {
        global: signal<File | null>(null),
        guild: signal<File | null>(null),
    };
    private readonly objectUrl: Record<AvatarHalf, ReturnType<typeof signal<string>>> = {
        global: signal(''),
        guild: signal(''),
    };
    private readonly cleared: Record<AvatarHalf, ReturnType<typeof signal<boolean>>> = {
        global: signal(false),
        guild: signal(false),
    };

    protected readonly cropSrc = signal('');
    private readonly cropFor = signal<AvatarHalf | null>(null);

    protected readonly globalAvatar = computed(
        () => this.objectUrl.global() || (this.cleared.global() ? '' : this.avatarUrl()),
    );
    protected readonly guildAvatar = computed(
        () => this.objectUrl.guild() || (this.cleared.guild() ? '' : this.guildAvatarUrl()),
    );

    protected readonly isCreate = computed(() => !this.target()?.persona);
    protected readonly hasGuildHalf = computed(() => !!this.target()?.guildId);
    protected readonly isGuildOwned = computed(() => !!this.target()?.guildOwned);

    protected readonly previewName = computed(() => this.displayName() || this.name());
    protected readonly previewAvatar = computed(() => this.guildAvatar() || this.globalAvatar());
    protected readonly previewColor = computed(() => safeAccentColor(this.color()));

    protected get swatches(): readonly string[] {
        return ARCHIVE_COLORS;
    }

    protected get fallbackColor(): string {
        return ARCHIVE_COLOR_FALLBACK;
    }

    protected readonly pickedColor = computed(() => this.color().trim().toLowerCase());

    protected readonly tagPreview = computed(() =>
        formatProxyTags({prefix: this.proxyPrefix(), suffix: this.proxySuffix()}),
    );

    /**
     * Named so the message can say which character is already using the pair. Only the caller's own
     * cast is visible, so another player's tag gets through to the server and comes back as a 409.
     */
    protected readonly tagCollision = computed(() => {
        const target = this.target();
        if (!target?.guildId) return null;
        const others = this.personas.cast(target.guildId).map(proxyTagsOf);
        const clash = findTagCollision(
            {prefix: this.proxyPrefix(), suffix: this.proxySuffix()},
            target.persona?.id ?? '',
            others,
        );
        if (!clash) return null;
        return this.personas.entry(target.guildId, clash.personaId)?.persona.name ?? null;
    });

    protected readonly canSave = computed(() => !!this.name().trim() && !this.tagCollision());

    constructor() {
        effect(() => {
            const target = this.target();
            untracked(() => this.load(target));
        });

        inject(DestroyRef).onDestroy(() => {
            this.release('global');
            this.release('guild');
        });
    }

    protected inherited(value: string): boolean {
        return !value.trim();
    }

    protected onAvatarPicked(event: Event, half: AvatarHalf): void {
        const input = event.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;

        if (file.size > MAX_PICK_BYTES) {
            this.toast.error(this.translate.instant('PERSONA.FIELD.AVATAR_TOO_LARGE', {max: MAX_PICK_MB}));
            return;
        }

        const reader = new FileReader();
        reader.onload = () => {
            this.cropFor.set(half);
            this.cropSrc.set(reader.result as string);
        };
        reader.readAsDataURL(file);
    }

    protected onCropConfirmed(file: File): void {
        const half = this.cropFor();
        this.cancelCrop();
        if (!half) return;

        this.release(half);
        this.pending[half].set(file);
        this.objectUrl[half].set(URL.createObjectURL(file));
        this.cleared[half].set(false);
    }

    protected cancelCrop(): void {
        this.cropSrc.set('');
        this.cropFor.set(null);
    }

    protected clearAvatar(half: AvatarHalf): void {
        this.release(half);
        this.pending[half].set(null);
        this.cleared[half].set(true);
    }

    /** Whether the half has a picture to show, so the template can offer Remove rather than Upload. */
    protected hasAvatar(half: AvatarHalf): boolean {
        return !!(half === 'global' ? this.globalAvatar() : this.guildAvatar());
    }

    private release(half: AvatarHalf): void {
        const url = this.objectUrl[half]();
        if (url) URL.revokeObjectURL(url);
        this.objectUrl[half].set('');
    }

    protected save(): void {
        const target = this.target();
        if (!target || !this.canSave()) return;

        const global = {
            name: this.name().trim(),
            avatarUrl: this.avatarUrl().trim() || null,
            pronouns: this.pronouns().trim() || null,
            color: safeAccentColor(this.color()),
            shortBio: this.shortBio().trim() || null,
        };

        const overrides = {
            displayName: this.displayName().trim() || null,
            avatarUrl: this.guildAvatarUrl().trim() || null,
            tag: this.tag().trim() || null,
            proxyPrefix: this.proxyPrefix().trim() || null,
            proxySuffix: this.proxySuffix().trim() || null,
        };

        this.saving.set(true);
        this.conflict.set('');

        const guildId = target.guildId;
        const existing = target.persona;

        let request: Observable<unknown>;
        if (existing) {
            const persona: Observable<unknown> =
                target.guildOwned && guildId
                    ? this.personas.updateGuildPersona(guildId, existing.id, global)
                    : this.personas.updateOwn(existing.id, global);
            const profile: Observable<unknown> =
                guildId && target.entry
                    ? this.personas.saveProfile(guildId, existing.id, overrides)
                    : of(null);
            // The avatars go last: both writes above carry an avatarUrl of their own and would
            // overwrite whatever an upload had just set.
            request = forkJoin([persona, profile]).pipe(
                switchMap(() => this.avatarWrites(existing.id, guildId, !!target.entry)),
            );
        } else {
            const created: Observable<string> =
                target.guildOwned && guildId
                    ? this.personas.createGuildPersona(guildId, global).pipe(map(e => e.persona.id))
                    : this.personas.createOwn(global).pipe(map(p => p.id));
            // Creating from inside a guild adopts it there in the same gesture; without this the
            // character is made and is then in no guild at all.
            request = created.pipe(
                switchMap(personaId => {
                    const adopt: Observable<unknown> =
                        guildId && !target.guildOwned
                            ? this.personas.saveProfile(guildId, personaId, overrides)
                            : of(null);
                    return adopt.pipe(map(() => personaId));
                }),
                switchMap(personaId => this.avatarWrites(personaId, guildId, true)),
            );
        }

        request.subscribe({
            next: () => {
                this.saving.set(false);
                this.saved.emit();
                this.closed.emit();
            },
            error: (err: unknown) => {
                this.saving.set(false);

                // The route answers 409 for a taken proxy tag and for a taken display name alike,
                // with the sentence as the whole body and no code to tell the two apart.
                if (err instanceof HttpErrorResponse && err.status === 409) {
                    this.conflict.set(
                        apiErrorMessage(err) ?? this.translate.instant('PERSONA.EDITOR.SAVE_CONFLICT'),
                    );
                    return;
                }

                this.toast.httpError(this.translate.instant('PERSONA.EDITOR.SAVE_FAILED'), err);
            },
        });
    }

    /**
     * The character is already saved by the time these run, so a picture that fails to land is
     * reported on its own rather than turning the whole save into a failure the user would retry.
     */
    private avatarWrites(personaId: string, guildId: string | null, adopted: boolean): Observable<unknown> {
        const ops: Observable<unknown>[] = [];

        const pendingGlobal = this.pending.global();
        if (pendingGlobal) ops.push(this.personas.uploadAvatar(personaId, pendingGlobal));
        else if (this.cleared.global() && this.avatarUrl()) ops.push(this.personas.removeAvatar(personaId));

        if (guildId && adopted) {
            const pendingGuild = this.pending.guild();
            if (pendingGuild) ops.push(this.personas.uploadProfileAvatar(guildId, personaId, pendingGuild));
            else if (this.cleared.guild() && this.guildAvatarUrl())
                ops.push(this.personas.removeProfileAvatar(guildId, personaId));
        }

        if (!ops.length) return of(null);

        return forkJoin(ops).pipe(
            catchError((err: unknown) => {
                this.toast.httpError(this.translate.instant('PERSONA.EDITOR.AVATAR_FAILED'), err);
                return of(null);
            }),
        );
    }

    private load(target: PersonaEditorTarget | null): void {
        this.conflict.set('');
        this.cancelCrop();

        for (const half of ['global', 'guild'] as const) {
            this.release(half);
            this.pending[half].set(null);
            this.cleared[half].set(false);
        }

        const persona = target?.persona;
        this.name.set(persona?.name ?? '');
        this.avatarUrl.set(persona?.avatarUrl ?? '');
        this.pronouns.set(persona?.pronouns ?? '');
        this.color.set(persona?.color ?? '');
        this.shortBio.set(persona?.shortBio ?? '');

        const profile = target?.entry;
        this.displayName.set(profile?.displayName ?? '');
        this.guildAvatarUrl.set(profile?.avatarUrl ?? '');
        this.tag.set(profile?.tag ?? '');
        this.proxyPrefix.set(profile?.proxyPrefix ?? '');
        this.proxySuffix.set(profile?.proxySuffix ?? '');
    }
}
