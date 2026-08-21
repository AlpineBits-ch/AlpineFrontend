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
import {Observable} from 'rxjs';
import {Dialog} from 'primeng/dialog';
import {PrimeTemplate} from 'primeng/api';
import {PersonaAvatarComponent} from '../../personas/persona-avatar/persona-avatar.component';
import {PersonaService} from '../../../../services/persona.service';
import {SceneService} from '../../../../services/scene.service';
import {ToastService} from '../../../../services/toast.service';
import {SceneDto} from '../../../../dtos/response/scene.dto';
import {JOIN_NOTE_MAX} from '../../../../dtos/request/scene.dto';
import {matchesPersonaQuery, personaIdentity, PersonaIdentity} from '../../personas/persona-identity';
import {needsPermission} from '../scene-access';

interface JoinRow {
    personaId: string;
    identity: PersonaIdentity;
}

/**
 * Bringing a character into a scene, or asking to. One dialog for both because the question is the
 * same one: which of yours, and is there anything the GM should know.
 */
@Component({
    selector: 'app-scene-join-dialog',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [FormsModule, TranslateModule, Dialog, PrimeTemplate, PersonaAvatarComponent],
    templateUrl: './scene-join-dialog.component.html',
    styleUrl: './scene-join-dialog.component.css',
})
export class SceneJoinDialogComponent {
    readonly guildId = input.required<string>();
    readonly scene = input.required<SceneDto>();
    readonly closed = output<void>();

    private readonly personas = inject(PersonaService);
    private readonly scenes = inject(SceneService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);

    protected get NOTE_MAX() {
        return JOIN_NOTE_MAX;
    }

    protected readonly query = signal('');
    protected readonly note = signal('');
    protected readonly chosen = signal<string | null>(null);
    protected readonly saving = signal(false);

    /** Asking rather than walking in. Decides the copy, the note field and the route. */
    protected readonly asking = computed(() => needsPermission(this.scene()));

    /** Only characters this reader may speak as, and only ones not already in the scene. */
    protected readonly rows = computed((): JoinRow[] => {
        const cast = new Set(this.scene().participants.map(p => p.personaId));
        const query = this.query();
        return this.personas
            .speakable(this.guildId())
            .filter(entry => !cast.has(entry.persona.id) && matchesPersonaQuery(entry, query))
            .map(entry => ({personaId: entry.persona.id, identity: personaIdentity(entry)}));
    });

    protected readonly hasNone = computed(() => !this.query() && this.rows().length === 0);

    /** Who the new character follows in the rotation. Absent while the cast is still empty. */
    protected readonly lastInOrder = computed((): string | null => {
        const scene = this.scene();
        const order = scene.turnOrder.length ? scene.turnOrder : scene.participants.map(p => p.personaId);
        const last = order[order.length - 1];
        if (!last) return null;
        return this.personas.identity(this.guildId(), last, participantHint(scene, last))?.name ?? null;
    });

    constructor() {
        effect(() => {
            const guildId = this.guildId();
            untracked(() => this.personas.ensureCast(guildId));
        });

        // One character is not a choice. Pre-picking it turns the dialog into a confirmation.
        effect(() => {
            const rows = this.rows();
            untracked(() => {
                if (this.chosen() || rows.length !== 1) return;
                this.chosen.set(rows[0].personaId);
            });
        });
    }

    protected pick(personaId: string): void {
        this.chosen.set(personaId);
    }

    protected confirm(): void {
        const personaId = this.chosen();
        if (!personaId || this.saving()) return;
        this.saving.set(true);

        const guildId = this.guildId();
        const channelId = this.scene().channelId;
        const asking = this.asking();
        // Two different answers, neither of them read here: the store absorbs both.
        const work: Observable<unknown> = asking
            ? this.scenes.requestJoin(guildId, channelId, {
                  personaId,
                  note: this.note().trim() || null,
              })
            : this.scenes.join(guildId, channelId, personaId);

        work.subscribe({
            next: () => {
                this.saving.set(false);
                this.toast.success(this.translate.instant(asking ? 'SCENE.JOIN.ASKED' : 'SCENE.JOIN.JOINED'));
                this.closed.emit();
            },
            error: err => {
                this.saving.set(false);
                this.toast.httpError(this.translate.instant('SCENE.JOIN.FAILED'), err);
            },
        });
    }
}

/** The scene's own copy of a character's display fields, for one the guild cast does not carry. */
function participantHint(scene: SceneDto, personaId: string) {
    return scene.participants.find(p => p.personaId === personaId) ?? null;
}
