import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    ElementRef,
    inject,
    input,
    signal,
    viewChild,
} from '@angular/core';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {RelativeTimePipe} from '../../../../pipes/relative-time.pipe';
import {TurnRailComponent} from '../turn-rail/turn-rail.component';
import {SceneDialogComponent} from '../scene-dialog/scene-dialog.component';
import {SceneConcludeDialogComponent} from '../scene-conclude-dialog/scene-conclude-dialog.component';
import {SceneService} from '../../../../services/scene.service';
import {PersonaService} from '../../../../services/persona.service';
import {ToastService} from '../../../../services/toast.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {SceneDto, SceneStatus} from '../../../../dtos/response/scene.dto';
import {ChannelDto} from '../../../../dtos/response/guild.dto';
import {sceneStatusMeta} from '../scene-status';

/**
 * The strip under a scene channel's title: the turn rail, the in-character / out-of-character pair,
 * and the two verbs a game master needs when a scene has stopped moving.
 */
@Component({
    selector: 'app-scene-header',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        TranslateModule,
        RelativeTimePipe,
        TurnRailComponent,
        SceneDialogComponent,
        SceneConcludeDialogComponent,
    ],
    templateUrl: './scene-header.component.html',
    styleUrl: './scene-header.component.css',
})
export class SceneHeaderComponent {
    readonly guildId = input.required<string>();
    readonly scene = input.required<SceneDto>();
    /** Which half of the pair is on screen. The scene channel is `ic`, its companion thread `ooc`. */
    readonly side = input<'ic' | 'ooc'>('ic');
    readonly canManage = input(false);
    /** Every channel in the guild, so the pair can navigate without another lookup. */
    readonly guildChannels = input<ChannelDto[]>([]);

    protected readonly scenes = inject(SceneService);
    private readonly personas = inject(PersonaService);
    private readonly nav = inject(NavigationService);
    private readonly toast = inject(ToastService);
    private readonly translate = inject(TranslateService);

    protected readonly SceneStatus = SceneStatus;
    protected readonly busy = signal(false);
    protected readonly editing = signal(false);
    protected readonly concluding = signal(false);
    protected readonly menuOpen = signal(false);

    private readonly menuRef = viewChild<ElementRef<HTMLElement>>('menu');

    constructor() {
        // Focused on open so a click elsewhere blurs it; the panel would otherwise never close.
        effect(() => {
            if (this.menuOpen()) queueMicrotask(() => this.menuRef()?.nativeElement.focus());
        });
    }

    /** Closes only when focus has actually left the panel, not when it moves between its buttons. */
    protected onMenuBlur(event: FocusEvent): void {
        const panel = this.menuRef()?.nativeElement;
        const next = event.relatedTarget as Node | null;
        if (panel && next && panel.contains(next)) return;
        this.menuOpen.set(false);
    }

    protected readonly status = computed(() => sceneStatusMeta(this.scene().status));

    protected readonly oocChannel = computed(() => {
        const id = this.scene().oocThreadId;
        return id ? (this.guildChannels().find(c => c.id === id) ?? null) : null;
    });

    protected readonly icChannel = computed(
        () => this.guildChannels().find(c => c.id === this.scene().channelId) ?? null,
    );

    /** Both halves have to exist before the pair is offered; one alone is just a channel. */
    protected readonly hasPair = computed(() => !!this.oocChannel() && !!this.icChannel());

    protected readonly currentIdentity = computed(() => {
        const scene = this.scene();
        const participant = scene.participants.find(p => p.personaId === scene.currentTurnPersonaId);
        return this.personas.identity(this.guildId(), scene.currentTurnPersonaId, participant);
    });

    /** Two missed deadlines is when the sweep escalates, and when a game master should hear it. */
    protected readonly isStalled = computed(
        () => this.scene().status === SceneStatus.Active && (this.scene().nudgeCount ?? 0) >= 2,
    );

    protected readonly waitingSince = computed(
        () => this.scene().turnStartedAt ?? this.scene().lastPostAt ?? null,
    );

    protected openIc(): void {
        const channel = this.icChannel();
        if (channel) this.nav.openChannel(channel);
    }

    protected openOoc(): void {
        const channel = this.oocChannel();
        if (channel) this.nav.openChannel(channel);
    }

    protected skipTurn(): void {
        this.run(this.scenes.skipTurn(this.guildId(), this.scene().channelId), 'SCENE.TOAST.SKIPPED');
    }

    protected setStatus(status: SceneStatus): void {
        this.run(
            this.scenes.update(this.guildId(), this.scene().channelId, {status}),
            status === SceneStatus.Paused ? 'SCENE.TOAST.PAUSED' : 'SCENE.TOAST.RESUMED',
        );
    }

    private run(work: ReturnType<SceneService['skipTurn']>, successKey: string): void {
        this.menuOpen.set(false);
        this.busy.set(true);
        work.subscribe({
            next: () => {
                this.busy.set(false);
                this.toast.success(this.translate.instant(successKey));
            },
            error: err => {
                this.busy.set(false);
                this.toast.httpError(this.translate.instant('SCENE.TOAST.FAILED'), err);
            },
        });
    }
}
