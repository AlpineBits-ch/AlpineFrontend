import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    ElementRef,
    inject,
    input,
    signal,
    untracked,
    viewChild,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {PersonaAvatarComponent} from '../persona-avatar/persona-avatar.component';
import {PersonaService} from '../../../../services/persona.service';
import {ToastService} from '../../../../services/toast.service';
import {AutoproxyMode, GuildPersonaDto} from '../../../../dtos/response/persona.dto';
import {matchesPersonaQuery, personaIdentity, PersonaIdentity, sortPersonas} from '../persona-identity';
import {formatProxyTags, ProxySource, proxyTagsOf} from '../persona-proxy';
import {approvalMeta} from '../persona-approval';

/** One row in the panel. `null` identity is the "yourself" row. */
interface SwitcherRow {
    entry: GuildPersonaDto | null;
    identity: PersonaIdentity | null;
    tags: string;
    blockedReason: string | null;
}

/**
 * Who the next message is from, and how to change it without leaving the keyboard. Sits inside the
 * composer's box, above the editor, where the reply banner sits.
 */
@Component({
    selector: 'app-persona-switcher',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [PersonaAvatarComponent, TranslateModule, FormsModule],
    templateUrl: './persona-switcher.component.html',
})
export class PersonaSwitcherComponent {
    readonly guildId = input<string | null>(null);
    readonly channelId = input<string | null>(null);
    /** The editor's raw text, so the strip can show a proxy tag being eaten as it is typed. */
    readonly draft = input<string>('');

    protected readonly personas = inject(PersonaService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);

    protected readonly open = signal(false);
    protected readonly query = signal('');
    protected readonly cursor = signal(0);
    protected readonly savingMode = signal(false);

    private readonly searchRef = viewChild<ElementRef<HTMLInputElement>>('search');
    private readonly panelRef = viewChild<ElementRef<HTMLElement>>('panel');

    protected readonly AutoproxyMode = AutoproxyMode;

    protected readonly resolution = computed(() =>
        this.personas.resolveFor(this.guildId(), this.channelId(), this.draft()),
    );

    protected readonly speaker = computed((): PersonaIdentity | null => {
        const entry = this.personas.entry(this.guildId(), this.resolution().personaId);
        return entry ? personaIdentity(entry) : null;
    });

    protected readonly source = computed((): ProxySource => this.resolution().source);

    /** The one-line reason under the name. Only shown when the choice was not made by hand. */
    protected readonly sourceKey = computed((): string | null => {
        switch (this.source()) {
            case 'tag':
                return 'PERSONA.SWITCHER.FROM_TAG';
            case 'autoproxy':
                return 'PERSONA.SWITCHER.FROM_AUTOPROXY';
            case 'escaped':
                return 'PERSONA.SWITCHER.FROM_ESCAPE';
            default:
                return null;
        }
    });

    protected readonly matchedTag = computed(() => {
        const matched = this.resolution().matched;
        if (!matched) return '';
        return `${matched.prefix}${matched.suffix}`;
    });

    protected readonly autoproxy = computed(() => this.personas.autoproxy(this.channelId()));

    protected readonly cast = computed(() => sortPersonas(this.personas.cast(this.guildId())));

    protected readonly rows = computed((): SwitcherRow[] => {
        const query = this.query();
        const rows: SwitcherRow[] = [{entry: null, identity: null, tags: '', blockedReason: null}];

        for (const entry of this.cast()) {
            if (!matchesPersonaQuery(entry, query)) continue;
            rows.push({
                entry,
                identity: personaIdentity(entry),
                tags: formatProxyTags(proxyTagsOf(entry)),
                blockedReason: this.blockedReason(entry),
            });
        }
        return rows;
    });

    protected readonly selectable = computed(() => this.rows().filter(r => !r.blockedReason));

    protected readonly isEmpty = computed(() => this.cast().length === 0);

    constructor() {
        effect(() => {
            const guildId = this.guildId();
            const channelId = this.channelId();
            untracked(() => {
                this.personas.ensureCast(guildId);
                this.personas.ensureAutoproxy(guildId, channelId);
            });
        });

        // Reopening on a stale query would hide the character somebody is reaching for.
        effect(() => {
            if (this.open()) {
                untracked(() => {
                    this.query.set('');
                    this.cursor.set(0);
                });
                queueMicrotask(() => this.searchRef()?.nativeElement.focus());
            }
        });
    }

    /** Called by the composer on Alt+P, so the switcher never needs a global hotkey of its own. */
    toggle(): void {
        this.open.update(v => !v);
    }

    close(): void {
        this.open.set(false);
    }

    protected onTriggerKeydown(event: KeyboardEvent): void {
        if (event.key === 'ArrowUp' && !this.open()) {
            event.preventDefault();
            this.open.set(true);
        }
    }

    protected onPanelKeydown(event: KeyboardEvent): void {
        const rows = this.selectable();
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.close();
            return;
        }
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            this.cursor.update(i => Math.min(i + 1, rows.length - 1));
            return;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            this.cursor.update(i => Math.max(i - 1, 0));
            return;
        }
        if (event.key === 'Enter') {
            event.preventDefault();
            const row = rows[this.cursor()];
            if (row) this.pick(row);
        }
    }

    protected onBlur(event: FocusEvent): void {
        const panel = this.panelRef()?.nativeElement;
        const next = event.relatedTarget as Node | null;
        if (panel && next && panel.contains(next)) return;
        this.close();
    }

    protected pick(row: SwitcherRow): void {
        const channelId = this.channelId();
        if (!channelId || row.blockedReason) return;
        this.personas.select(channelId, row.entry?.persona.id ?? null);
        this.close();
    }

    protected rowClass(row: SwitcherRow): string {
        if (row.blockedReason) return 'opacity-45 cursor-default bg-transparent';
        const focused = this.selectable()[this.cursor()] === row;
        return focused
            ? 'cursor-pointer bg-white/[0.06]'
            : 'cursor-pointer bg-transparent hover:bg-white/[0.05]';
    }

    protected isCurrent(row: SwitcherRow): boolean {
        return (row.entry?.persona.id ?? null) === this.resolution().personaId;
    }

    protected setMode(mode: AutoproxyMode): void {
        const guildId = this.guildId();
        const channelId = this.channelId();
        if (!guildId || !channelId) return;

        // Pinned needs a character and Sticky takes one as its starting value; either way the one
        // on screen is the only one either could sensibly mean.
        const personaId = mode === AutoproxyMode.Off ? null : this.resolution().personaId;
        if (mode === AutoproxyMode.Pinned && !personaId) {
            this.toast.warn(this.translate.instant('PERSONA.AUTOPROXY.PINNED_NEEDS_PERSONA'));
            return;
        }

        this.savingMode.set(true);
        this.personas.setAutoproxy(guildId, channelId, mode, personaId).subscribe({
            next: () => this.savingMode.set(false),
            error: err => {
                this.savingMode.set(false);
                this.toast.httpError(this.translate.instant('PERSONA.AUTOPROXY.SAVE_FAILED'), err);
            },
        });
    }

    protected modeLabelKey(mode: AutoproxyMode): string {
        return `PERSONA.AUTOPROXY.${mode.toUpperCase()}`;
    }

    protected modeHintKey(mode: AutoproxyMode): string {
        return `PERSONA.AUTOPROXY.${mode.toUpperCase()}_HINT`;
    }

    private blockedReason(entry: GuildPersonaDto): string | null {
        if (entry.persona.isRetired) return 'PERSONA.SWITCHER.RETIRED';
        if (!entry.canSpeak) return approvalMeta(entry.approvalState).labelKey;
        return null;
    }
}
