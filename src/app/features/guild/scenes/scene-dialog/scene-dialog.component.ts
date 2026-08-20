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
import {Dialog} from 'primeng/dialog';
import {Select} from 'primeng/select';
import {PrimeTemplate} from 'primeng/api';
import {PersonaAvatarComponent} from '../../personas/persona-avatar/persona-avatar.component';
import {PersonaService} from '../../../../services/persona.service';
import {SceneService} from '../../../../services/scene.service';
import {ToastService} from '../../../../services/toast.service';
import {SceneDto, SceneStatus} from '../../../../dtos/response/scene.dto';
import {ChannelDto} from '../../../../dtos/response/guild.dto';
import {
    identityFromCastMember,
    matchesCastMemberQuery,
    PersonaIdentity,
} from '../../personas/persona-identity';

/** The deadlines a play-by-post game actually uses, rather than a number field. */
export const TURN_LENGTHS: readonly {hours: number | null; labelKey: string}[] = [
    {hours: null, labelKey: 'SCENE.DEADLINE.NONE'},
    {hours: 24, labelKey: 'SCENE.DEADLINE.ONE_DAY'},
    {hours: 48, labelKey: 'SCENE.DEADLINE.TWO_DAYS'},
    {hours: 72, labelKey: 'SCENE.DEADLINE.THREE_DAYS'},
    {hours: 168, labelKey: 'SCENE.DEADLINE.ONE_WEEK'},
];

interface CastRow {
    personaId: string;
    identity: PersonaIdentity | null;
}

/** A turn length read back off a running scene, since the read model does not carry one. */
interface DerivedTurnLength {
    hours: number;
    /** False when the span lands between the presets, and no chip may be lit for it. */
    onPreset: boolean;
}

/**
 * Setting a scene up: its name, who is in it, in what order, and how long a turn lasts. Editing an
 * existing scene reuses it, because the questions are the same ones.
 */
@Component({
    selector: 'app-scene-dialog',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [FormsModule, TranslateModule, Dialog, Select, PrimeTemplate, PersonaAvatarComponent],
    templateUrl: './scene-dialog.component.html',
    styleUrl: './scene-dialog.component.css',
})
export class SceneDialogComponent {
    readonly guildId = input.required<string>();
    /** Absent when creating. Then the home channel is picked in the dialog. */
    readonly scene = input<SceneDto | null>(null);
    /** Offered as the scene's home. A scene opens as a thread under one of them. */
    readonly guildChannels = input<ChannelDto[]>([]);
    readonly closed = output<void>();

    private readonly personas = inject(PersonaService);
    private readonly scenes = inject(SceneService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);

    protected get TURN_LENGTHS() {
        return TURN_LENGTHS;
    }

    protected readonly name = signal('');
    protected readonly description = signal('');
    protected readonly oocName = signal('');
    protected readonly order = signal<string[]>([]);
    protected readonly deadlineHours = signal<number | null>(48);
    /** Whether the turn length was chosen here. Untouched, the PATCH leaves the scene's own alone. */
    protected readonly deadlineTouched = signal(false);
    protected readonly query = signal('');
    protected readonly saving = signal(false);
    protected readonly homeChannelId = signal<string | null>(null);

    private seeded = false;

    protected readonly isEdit = computed(() => !!this.scene());

    /** Where the scene thread opens. One candidate channel needs no choosing. */
    protected readonly home = computed(() => {
        const chosen = this.homeChannelId();
        if (chosen) return chosen;
        const channels = this.guildChannels();
        return channels.length === 1 ? channels[0].id : null;
    });

    protected readonly homeOptions = computed(() =>
        this.guildChannels().map(channel => ({label: `#${channel.name}`, value: channel.id})),
    );

    constructor() {
        effect(() => {
            const guildId = this.guildId();
            untracked(() => {
                this.personas.ensureCast(guildId);
                this.personas.ensureGuildCast(guildId);
            });
        });

        effect(() => {
            const scene = this.scene();
            untracked(() => {
                // Seeded once. Realtime replaces the scene object on every post, and a re-seed would
                // throw away the reorder being made here.
                if (this.seeded || !scene) return;
                this.seeded = true;
                this.name.set(scene.name);
                // The rotation is the cast here, and an empty turn order means the cast in join order.
                this.order.set(
                    scene.turnOrder.length
                        ? [...scene.turnOrder]
                        : scene.participants.map(participant => participant.personaId),
                );
            });
        });
    }

    /** In turn order, which is the order the scene plays in and therefore the order shown. */
    protected readonly cast = computed((): CastRow[] =>
        this.order().map(personaId => ({
            personaId,
            identity: this.personas.identity(
                this.guildId(),
                personaId,
                this.scene()?.participants.find(p => p.personaId === personaId),
            ),
        })),
    );

    protected readonly castLoading = computed(() => this.personas.isGuildCastLoading(this.guildId()));

    /** Everyone the guild plays, not only the characters the game master owns. */
    protected readonly addable = computed(() =>
        this.personas.guildCast(this.guildId()).filter(member => !member.isRetired),
    );

    protected readonly available = computed((): CastRow[] => {
        const chosen = new Set(this.order());
        const query = this.query();
        return this.addable()
            .filter(member => !chosen.has(member.personaId) && matchesCastMemberQuery(member, query))
            .map(member => ({
                personaId: member.personaId,
                identity:
                    this.personas.identity(this.guildId(), member.personaId) ??
                    identityFromCastMember(member),
            }));
    });

    /** Read back off the deadline, never sent. Null when the scene cannot answer. */
    protected readonly derivedLength = computed(() => derivedTurnLength(this.scene()));

    /** Undefined lights no chip: the scene's own turn length is not known here. */
    protected readonly selectedHours = computed((): number | null | undefined => {
        if (!this.isEdit() || this.deadlineTouched()) return this.deadlineHours();
        const derived = this.derivedLength();
        return derived?.onPreset ? derived.hours : undefined;
    });

    protected readonly lengthNote = computed((): {key: string; params?: Record<string, unknown>} => {
        if (!this.isEdit()) return {key: 'SCENE.DIALOG.TURN_LENGTH_HINT'};
        if (this.deadlineTouched()) return {key: 'SCENE.DIALOG.TURN_LENGTH_REPLACE'};
        const derived = this.derivedLength();
        if (!derived) return {key: 'SCENE.DIALOG.TURN_LENGTH_UNKNOWN'};
        return derived.onPreset
            ? {key: 'SCENE.DIALOG.TURN_LENGTH_DERIVED'}
            : {key: 'SCENE.DIALOG.TURN_LENGTH_CUSTOM', params: {hours: derived.hours}};
    });

    protected readonly canSave = computed(() => {
        if (!this.order().length) return false;
        return this.isEdit() ? true : !!this.name().trim() && !!this.home();
    });

    protected pickLength(hours: number | null): void {
        this.deadlineHours.set(hours);
        this.deadlineTouched.set(true);
    }

    protected add(personaId: string): void {
        this.order.update(ids => [...ids, personaId]);
        this.query.set('');
    }

    protected remove(personaId: string): void {
        this.order.update(ids => ids.filter(id => id !== personaId));
    }

    protected move(personaId: string, by: number): void {
        this.order.update(ids => {
            const at = ids.indexOf(personaId);
            const to = at + by;
            if (at < 0 || to < 0 || to >= ids.length) return ids;
            const next = [...ids];
            next.splice(at, 1);
            next.splice(to, 0, personaId);
            return next;
        });
    }

    protected save(start: boolean): void {
        if (!this.canSave() || this.saving()) return;
        this.saving.set(true);

        const existing = this.scene();
        const work = existing
            ? this.scenes.update(this.guildId(), existing.channelId, {
                  participantPersonaIds: this.order(),
                  turnOrder: this.order(),
                  // Omitted rather than null: the PATCH would otherwise wipe a clock nobody touched.
                  ...(this.deadlineTouched() ? {turnLengthHours: this.deadlineHours()} : {}),
              })
            : this.scenes.create(this.guildId(), this.home() ?? '', {
                  name: this.name().trim(),
                  description: this.description().trim() || null,
                  oocName: this.oocName().trim() || null,
                  participantPersonaIds: this.order(),
                  turnOrder: this.order(),
                  turnLengthHours: this.deadlineHours(),
                  status: start ? SceneStatus.Active : SceneStatus.Open,
              });

        work.subscribe({
            next: () => {
                this.saving.set(false);
                this.toast.success(
                    this.translate.instant(existing ? 'SCENE.TOAST.SAVED' : 'SCENE.TOAST.CREATED'),
                );
                this.closed.emit();
            },
            error: err => {
                this.saving.set(false);
                this.toast.httpError(this.translate.instant('SCENE.TOAST.FAILED'), err);
            },
        });
    }
}

function derivedTurnLength(scene: SceneDto | null): DerivedTurnLength | null {
    if (!scene?.turnDeadlineAt) return null;
    const start = scene.turnStartedAt ?? scene.lastPostAt;
    if (!start) return null;
    const span = new Date(scene.turnDeadlineAt).getTime() - new Date(start).getTime();
    if (!Number.isFinite(span) || span <= 0) return null;
    const hours = Math.round(span / 3_600_000);
    return {hours, onPreset: TURN_LENGTHS.some(option => option.hours === hours)};
}
