import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    inject,
    input,
    output,
    signal,
    untracked,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {forkJoin, map, Observable, of, switchMap} from 'rxjs';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PrimeTemplate} from 'primeng/api';
import {PersonaAvatarComponent} from '../persona-avatar/persona-avatar.component';
import {PersonaService} from '../../../../services/persona.service';
import {ToastService} from '../../../../services/toast.service';
import {GuildPersonaDto, PersonaDto} from '../../../../dtos/response/persona.dto';
import {safeAccentColor} from '../../../../models/profile-font.model';
import {findTagCollision, formatProxyTags, proxyTagsOf} from '../persona-proxy';

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
    imports: [Dialog, Button, PrimeTemplate, FormsModule, TranslateModule, PersonaAvatarComponent],
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

    protected readonly isCreate = computed(() => !this.target()?.persona);
    protected readonly hasGuildHalf = computed(() => !!this.target()?.guildId);
    protected readonly isGuildOwned = computed(() => !!this.target()?.guildOwned);

    protected readonly previewName = computed(() => this.displayName() || this.name());
    protected readonly previewAvatar = computed(() => this.guildAvatarUrl() || this.avatarUrl());
    protected readonly previewColor = computed(() => safeAccentColor(this.color()));

    protected readonly tagPreview = computed(() =>
        formatProxyTags({prefix: this.proxyPrefix(), suffix: this.proxySuffix()}),
    );

    /** Named so the message can say which character is already using the pair. */
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
    }

    protected inherited(value: string): boolean {
        return !value.trim();
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
            request = forkJoin([persona, profile]);
        } else {
            const created: Observable<string> =
                target.guildOwned && guildId
                    ? this.personas.createGuildPersona(guildId, global).pipe(map(e => e.persona.id))
                    : this.personas.createOwn(global).pipe(map(p => p.id));
            // Creating from inside a guild adopts it there in the same gesture; without this the
            // character is made and is then in no guild at all.
            request = created.pipe(
                switchMap(personaId =>
                    guildId && !target.guildOwned
                        ? this.personas.saveProfile(guildId, personaId, overrides)
                        : of(null),
                ),
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
                this.toast.httpError(this.translate.instant('PERSONA.EDITOR.SAVE_FAILED'), err);
            },
        });
    }

    private load(target: PersonaEditorTarget | null): void {
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
