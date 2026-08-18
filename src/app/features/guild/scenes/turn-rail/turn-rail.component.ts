import {ChangeDetectionStrategy, Component, computed, inject, input} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {RelativeTimePipe} from '../../../../pipes/relative-time.pipe';
import {PersonaAvatarComponent} from '../../personas/persona-avatar/persona-avatar.component';
import {PersonaIdentity} from '../../personas/persona-identity';
import {TurnClockRingComponent} from '../turn-clock-ring/turn-clock-ring.component';
import {PersonaService} from '../../../../services/persona.service';
import {SceneService} from '../../../../services/scene.service';
import {SceneDto, SceneParticipantDto, SceneStatus} from '../../../../dtos/response/scene.dto';
import {turnClock} from '../scene-clock';
import {isWaitingOnMe, queueFromCurrent} from '../scene-status';

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

    protected readonly SceneStatus = SceneStatus;

    protected readonly clock = computed(() => turnClock(this.scene(), this.scenes.now()));

    protected readonly isMyTurn = computed(() =>
        isWaitingOnMe(this.scene(), this.scenes.speakableIds(this.guildId())),
    );

    /** The whole queue rotated so the character who is up comes first. */
    private readonly queue = computed((): QueueEntry[] => {
        const scene = this.scene();
        const byId = new Map<string, SceneParticipantDto>(scene.participants.map(p => [p.personaId, p]));
        return queueFromCurrent(scene).map(personaId => {
            const participant = byId.get(personaId);
            return {
                personaId,
                identity: this.personas.identity(this.guildId(), personaId, participant),
                away: !!participant?.isAway,
            };
        });
    });

    protected readonly current = computed((): QueueEntry | null => {
        const scene = this.scene();
        if (!scene.currentTurnPersonaId) return null;
        return this.queue().find(entry => entry.personaId === scene.currentTurnPersonaId) ?? null;
    });

    /** A scene of one is a journal. It has a writer, not a queue. */
    protected readonly isSolo = computed(() => this.scene().turnOrder.length <= 1);

    protected readonly upcoming = computed(() => {
        if (this.isSolo()) return [];
        const rest = this.current() ? this.queue().slice(1) : this.queue();
        return rest.slice(0, UPCOMING_SHOWN);
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
}
