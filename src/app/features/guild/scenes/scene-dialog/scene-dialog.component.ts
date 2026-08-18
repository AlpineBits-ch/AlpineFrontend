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
import {PersonaIdentity, sortPersonas} from '../../personas/persona-identity';

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
    /** Absent when creating. Then `parentChannelId` says where the scene thread is opened. */
    readonly scene = input<SceneDto | null>(null);
    readonly parentChannelId = input<string | null>(null);
    /** Offered as the scene's home when more than one channel could hold it. */
    readonly guildChannels = input<ChannelDto[]>([]);
    readonly closed = output<void>();

    private readonly personas = inject(PersonaService);
    private readonly scenes = inject(SceneService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);

    protected readonly TURN_LENGTHS = TURN_LENGTHS;

    protected readonly name = signal('');
    protected readonly order = signal<string[]>([]);
    protected readonly deadlineHours = signal<number | null>(48);
    protected readonly query = signal('');
    protected readonly saving = signal(false);
    protected readonly homeChannelId = signal<string | null>(null);

    protected readonly isEdit = computed(() => !!this.scene());

    /** Where the scene thread opens. Only asked for when the guild has more than one candidate. */
    protected readonly home = computed(() => this.homeChannelId() ?? this.parentChannelId());
    protected readonly canChooseHome = computed(() => !this.isEdit() && this.guildChannels().length > 1);

    protected readonly homeOptions = computed(() =>
        this.guildChannels().map(channel => ({label: `#${channel.name}`, value: channel.id})),
    );

    constructor() {
        effect(() => {
            const guildId = this.guildId();
            untracked(() => this.personas.ensureCast(guildId));
        });

        effect(() => {
            const scene = this.scene();
            untracked(() => {
                if (!scene) return;
                this.name.set(scene.name);
                // The rotation is the cast here, and an empty turn order means the cast in join order.
                this.order.set(
                    scene.turnOrder.length
                        ? [...scene.turnOrder]
                        : scene.participants.map(participant => participant.personaId),
                );
                this.deadlineHours.set(hoursBetween(scene));
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

    /** Everything in the guild's cast that is not already in the scene. */
    protected readonly available = computed((): CastRow[] => {
        const chosen = new Set(this.order());
        const needle = this.query().trim().toLowerCase();
        return sortPersonas(this.personas.cast(this.guildId()))
            .filter(entry => !chosen.has(entry.persona.id))
            .map(entry => ({
                personaId: entry.persona.id,
                identity: this.personas.identity(this.guildId(), entry.persona.id),
            }))
            .filter(row => !needle || (row.identity?.name ?? '').toLowerCase().includes(needle));
    });

    protected readonly canSave = computed(() => !!this.name().trim() && this.order().length > 0);

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
                  turnLengthHours: this.deadlineHours(),
              })
            : this.scenes.create(this.guildId(), this.home() ?? '', {
                  name: this.name().trim(),
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

/** The turn length a scene is running, recovered from its deadline. */
function hoursBetween(scene: SceneDto): number | null {
    if (!scene.turnDeadlineAt) return null;
    const start = scene.turnStartedAt ?? scene.lastPostAt;
    if (!start) return 48;
    const span = new Date(scene.turnDeadlineAt).getTime() - new Date(start).getTime();
    if (!Number.isFinite(span) || span <= 0) return 48;
    const hours = Math.round(span / 3_600_000);
    return TURN_LENGTHS.reduce<number | null>(
        (best, option) =>
            option.hours !== null &&
            (best === null || Math.abs(option.hours - hours) < Math.abs(best - hours))
                ? option.hours
                : best,
        null,
    );
}
