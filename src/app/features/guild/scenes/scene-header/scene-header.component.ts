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
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Observable} from 'rxjs';
import {Dialog} from 'primeng/dialog';
import {Popover} from 'primeng/popover';
import {PrimeTemplate} from 'primeng/api';
import {PersonaAvatarComponent} from '../../personas/persona-avatar/persona-avatar.component';
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
 * and the verbs a game master needs when a scene has stopped moving.
 */
@Component({
    selector: 'app-scene-header',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        FormsModule,
        TranslateModule,
        RelativeTimePipe,
        Dialog,
        Popover,
        PrimeTemplate,
        PersonaAvatarComponent,
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

    protected get SceneStatus() {
        return SceneStatus;
    }

    protected readonly busy = signal(false);
    protected readonly editing = signal(false);
    protected readonly concluding = signal(false);
    protected readonly reopening = signal(false);
    protected readonly menuOpen = signal(false);
    protected readonly denyReason = signal('');
    private readonly denying = signal<string | null>(null);

    /** The asks still waiting on this game master. Empty for everybody else. */
    protected readonly requests = computed(() => this.scenes.pendingRequests(this.scene().channelId));

    private readonly menuRef = viewChild<ElementRef<HTMLElement>>('menu');
    private readonly triggerRef = viewChild<ElementRef<HTMLElement>>('menuTrigger');

    constructor() {
        effect(() => {
            if (this.menuOpen()) queueMicrotask(() => this.menuItems()[0]?.focus());
        });
    }

    /** Closes only when focus has actually left the panel, not when it moves between its items. */
    protected onMenuBlur(event: FocusEvent): void {
        const panel = this.menuRef()?.nativeElement;
        const next = event.relatedTarget as Node | null;
        if (panel && next && panel.contains(next)) return;
        this.menuOpen.set(false);
    }

    protected onMenuKeydown(event: KeyboardEvent): void {
        if (event.key === 'Escape') {
            event.preventDefault();
            this.closeMenu();
            return;
        }

        const items = this.menuItems();
        if (!items.length) return;
        const at = items.indexOf(document.activeElement as HTMLElement);

        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                items[(at + 1) % items.length].focus();
                break;
            case 'ArrowUp':
                event.preventDefault();
                items[(at <= 0 ? items.length : at) - 1].focus();
                break;
            case 'Home':
                event.preventDefault();
                items[0].focus();
                break;
            case 'End':
                event.preventDefault();
                items[items.length - 1].focus();
                break;
        }
    }

    /** Closing by keyboard or by picking an item puts focus back where it came from. */
    protected closeMenu(): void {
        this.menuOpen.set(false);
        this.triggerRef()?.nativeElement.focus();
    }

    private menuItems(): HTMLElement[] {
        const panel = this.menuRef()?.nativeElement;
        if (!panel) return [];
        return Array.from(panel.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])'));
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
        if (channel) this.nav.openSceneSide(channel);
    }

    protected openOoc(): void {
        const channel = this.oocChannel();
        if (channel) this.nav.openSceneSide(channel);
    }

    protected skipTurn(): void {
        this.run(this.scenes.skipTurn(this.guildId(), this.scene().channelId), 'SCENE.TOAST.SKIPPED');
    }

    /** Chases the current turn now, ignoring the grace period and quiet hours. */
    protected nudgeTurn(): void {
        this.run(this.scenes.nudgeTurn(this.guildId(), this.scene().channelId), 'SCENE.TOAST.NUDGED');
    }

    protected setStatus(status: SceneStatus): void {
        this.run(
            this.scenes.update(this.guildId(), this.scene().channelId, {status}),
            this.statusToastKey(status),
        );
    }

    protected reopen(): void {
        this.reopening.set(false);
        this.setStatus(SceneStatus.Active);
    }

    /** Which verb the button just carried out, which the target status alone cannot say. */
    private statusToastKey(status: SceneStatus): string {
        if (status === SceneStatus.Paused) return 'SCENE.TOAST.PAUSED';
        switch (this.scene().status) {
            case SceneStatus.Open:
                return 'SCENE.TOAST.STARTED';
            case SceneStatus.Concluded:
                return 'SCENE.TOAST.REOPENED';
            default:
                return 'SCENE.TOAST.RESUMED';
        }
    }

    protected approve(requestId: string): void {
        this.run(
            this.scenes.approveRequest(this.guildId(), this.scene().channelId, requestId),
            'SCENE.REQUEST.APPROVED',
        );
    }

    /** A reason is worth one panel, not one dialog. Opening it clears whatever the last one held. */
    protected openDeny(requestId: string, panel: Popover, event: Event): void {
        this.denying.set(requestId);
        this.denyReason.set('');
        panel.toggle(event);
    }

    protected deny(panel: Popover): void {
        const requestId = this.denying();
        if (!requestId) return;
        panel.hide();
        this.run(
            this.scenes.denyRequest(this.guildId(), this.scene().channelId, requestId, {
                reason: this.denyReason().trim() || null,
            }),
            'SCENE.REQUEST.DENIED',
        );
    }

    private run(work: Observable<unknown>, successKey: string): void {
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
