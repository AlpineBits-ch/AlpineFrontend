import {ChangeDetectionStrategy, Component, computed, effect, inject, input, untracked} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {RelativeTimePipe} from '../../../../pipes/relative-time.pipe';
import {PersonaAvatarComponent} from '../../personas/persona-avatar/persona-avatar.component';
import {PersonaIdentity} from '../../personas/persona-identity';
import {TurnClockRingComponent} from '../turn-clock-ring/turn-clock-ring.component';
import {PersonaService} from '../../../../services/persona.service';
import {SceneService} from '../../../../services/scene.service';
import {SceneDto, SceneParticipantDto, SceneStatus} from '../../../../dtos/response/scene.dto';
import {turnClock} from '../scene-clock';
import {isWaitingOnMe, upNext} from '../scene-status';

/** One character in the queue, with everything the rail needs to draw them. */
interface QueueEntry {
    personaId: string;
    identity: PersonaIdentity | null;
    away: boolean;
}

/** How many upcoming faces are drawn before the rest collapse into a count. */
const UPCOMING_SHOWN = 5;

/**
 * Whose turn it is, and how long they have had. The one thing a play-by-post game needs on screen
 * at all times, so it is furniture at the top of the scene rather than a notice that can be missed.
 */
@Component({
    selector: 'app-turn-rail',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [TranslateModule, RelativeTimePipe, PersonaAvatarComponent, TurnClockRingComponent],
    templateUrl: './turn-rail.component.html',
    styleUrl: './turn-rail.component.css',
})
export class TurnRailComponent {
    readonly guildId = input.required<string>();
    readonly scene = input.required<SceneDto>();

    private readonly personas = inject(PersonaService);
    protected readonly scenes = inject(SceneService);

    protected get SceneStatus() {
        return SceneStatus;
    }

    constructor() {
        effect(() => {
            const guildId = this.guildId();
            untracked(() => this.personas.ensureGuildCast(guildId));
        });
    }

    protected readonly clock = computed(() => turnClock(this.scene(), this.scenes.now()));

    protected readonly isMyTurn = computed(() =>
        isWaitingOnMe(this.scene(), this.scenes.speakableIds(this.guildId())),
    );

    /** An empty turn order means the cast in join order, the same rule the scene dialog applies. */
    private readonly rotation = computed((): string[] => {
        const scene = this.scene();
        return scene.turnOrder?.length ? [...scene.turnOrder] : scene.participants.map(p => p.personaId);
    });

    /** The whole rotation turned so the character who is up comes first. */
    private readonly queue = computed((): QueueEntry[] => {
        const scene = this.scene();
        const order = this.rotation();
        const at = scene.currentTurnPersonaId ? order.indexOf(scene.currentTurnPersonaId) : -1;
        const rotated = at < 0 ? order : [...order.slice(at), ...order.slice(0, at)];
        return rotated.map(personaId => this.entryFor(personaId));
    });

    protected readonly current = computed((): QueueEntry | null => {
        const scene = this.scene();
        if (!scene.currentTurnPersonaId) return null;
        return (
            this.queue().find(entry => entry.personaId === scene.currentTurnPersonaId) ??
            this.entryFor(scene.currentTurnPersonaId)
        );
    });

    /** A scene of one is a journal. It has a writer, not a queue. */
    protected readonly isSolo = computed(() => this.rotation().length <= 1);

    /** Who the server will actually hand the turn to, absences skipped. */
    private readonly next = computed(() => upNext({...this.scene(), turnOrder: this.rotation()}));

    protected readonly upcoming = computed((): QueueEntry[] => {
        if (this.isSolo()) return [];
        const rest = this.current() ? this.queue().slice(1) : this.queue();
        const next = this.next();
        const at = next ? rest.findIndex(entry => entry.personaId === next) : -1;
        const ordered = at > 0 ? [rest[at], ...rest.slice(0, at), ...rest.slice(at + 1)] : rest;
        return ordered.slice(0, UPCOMING_SHOWN);
    });

    protected readonly overflow = computed(() => {
        if (this.isSolo()) return 0;
        const rest = this.current() ? this.queue().length - 1 : this.queue().length;
        return Math.max(rest - UPCOMING_SHOWN, 0);
    });

    /** Shown only where the server counts turns. A ledger with no numbers is not a ledger. */
    protected readonly turnNumber = computed(() => {
        const value = this.scene().turnNumber;
        return typeof value === 'number' && value > 0 ? value : null;
    });

    protected readonly castCount = computed(() => this.scene().participants.length);

    private readonly byId = computed(
        () => new Map<string, SceneParticipantDto>(this.scene().participants.map(p => [p.personaId, p])),
    );

    private entryFor(personaId: string): QueueEntry {
        const participant = this.byId().get(personaId);
        return {
            personaId,
            identity: this.personas.identity(this.guildId(), personaId, participant),
            away: !!participant?.isAway,
        };
    }
}
