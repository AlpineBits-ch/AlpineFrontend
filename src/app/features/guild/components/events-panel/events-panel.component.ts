import {ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, input, signal, untracked} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {DatePipe} from '@angular/common';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Button} from 'primeng/button';
import {ConfirmationService} from 'primeng/api';
import {ConfirmDialog} from 'primeng/confirmdialog';
import {ScheduledEventStore} from '../../../../stores/scheduled-event.store';
import {ScheduledEventDto} from '../../../../dtos/response/scheduled-event.dto';
import {hasPermission, parsePermissions, Permissions} from '../../../../enums/permissions.enum';
import {
    GuildWebsocketService,
    WsEventCancelled,
    WsEventCreated,
    WsEventUpdated,
} from '../../../../services/guild-websocket.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {VoiceChannelService} from '../../../../services/voice-channel.service';
import {ToastService} from '../../../../services/toast.service';
import {EventEditorDialogComponent} from './event-editor-dialog.component';

@Component({
    selector: 'app-events-panel',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [DatePipe, TranslateModule, Button, ConfirmDialog, EventEditorDialogComponent],
    providers: [ConfirmationService],
    templateUrl: './events-panel.component.html',
})
export class EventsPanelComponent {
    guildId = input.required<string>();
    memberPermissions = input.required<string>();

    protected readonly navService = inject(NavigationService);
    protected readonly store = inject(ScheduledEventStore);
    private readonly guildWs = inject(GuildWebsocketService);
    private readonly voiceChannelSvc = inject(VoiceChannelService);
    private readonly toastService = inject(ToastService);
    private readonly translate = inject(TranslateService);
    private readonly confirmationService = inject(ConfirmationService);
    private readonly destroyRef = inject(DestroyRef);

    protected canManage = computed(() =>
        hasPermission(parsePermissions(this.memberPermissions()), Permissions.ManageEvents));

    // The server never advances an event's status past Scheduled except via cancel
    // (and cancelled events are excluded from the list entirely) -so "happening" vs
    // "over" must be derived from the timestamps, never from `status`.
    private readonly events = computed(() => this.store.eventsForGuild(this.guildId()));
    protected upcoming = computed(() =>
        this.events().filter(e => new Date(e.endsAt ?? e.startsAt).getTime() >= Date.now()));
    protected past = computed(() =>
        this.events()
            .filter(e => new Date(e.endsAt ?? e.startsAt).getTime() < Date.now())
            .slice()
            .reverse());

    protected showPast = signal(false);
    protected editorVisible = signal(false);
    protected editingEvent = signal<ScheduledEventDto | null>(null);

    constructor() {
        // `loadFor` reads AND patches loadingGuilds/loadedGuilds internally -tracking
        // only `guildId()` here (and calling loadFor untracked) keeps this effect from
        // re-running itself into a request storm off the store's own state changes.
        effect(() => {
            const id = this.guildId();
            untracked(() => this.store.loadFor(id));
        });

        this.guildWs.eventCreatedObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((e: WsEventCreated) => {
                if (e.guildId !== this.guildId()) return;
                this.store.applyRealtimeCreatedOrUpdated(e.guildId);
            });

        this.guildWs.eventUpdatedObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((e: WsEventUpdated) => {
                if (e.guildId !== this.guildId()) return;
                this.store.applyRealtimeCreatedOrUpdated(e.guildId);
            });

        this.guildWs.eventCancelledObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((e: WsEventCancelled) => {
                if (e.guildId !== this.guildId()) return;
                this.store.applyRealtimeCancelled(e.eventId);
            });
    }

    protected openCreate(): void {
        this.editingEvent.set(null);
        this.editorVisible.set(true);
    }

    protected openEdit(event: ScheduledEventDto): void {
        this.editingEvent.set(event);
        this.editorVisible.set(true);
    }

    protected confirmCancel(event: ScheduledEventDto): void {
        this.confirmationService.confirm({
            message: this.translate.instant('EVENTS.CANCEL_CONFIRM_MESSAGE', {title: event.title}),
            header: this.translate.instant('EVENTS.CANCEL_CONFIRM_HEADER'),
            icon: 'pi pi-calendar-times',
            acceptLabel: this.translate.instant('EVENTS.CANCEL_CONFIRM_ACCEPT'),
            rejectLabel: this.translate.instant('EVENTS.CANCEL_CONFIRM_REJECT'),
            acceptButtonProps: {severity: 'danger', size: 'small'},
            rejectButtonProps: {severity: 'secondary', outlined: true, size: 'small'},
            accept: () => {
                this.store.cancel(event.id).subscribe({
                    next: () => this.toastService.success(this.translate.instant('EVENTS.CANCEL_SUCCESS')),
                    error: err => this.toastService.httpError(this.translate.instant('EVENTS.CANCEL_ERROR'), err),
                });
            },
        });
    }

    protected toggleInterest(event: ScheduledEventDto): void {
        this.store.toggleInterest(event).subscribe({
            error: err => this.toastService.httpError(this.translate.instant('EVENTS.INTEREST_ERROR'), err),
        });
    }

    protected joinVoice(channelId: string): void {
        const ws = this.navService.workspace();
        if (ws.type !== 'server') return;
        const channel = ws.guild.channels.find(c => c.id === channelId);
        if (!channel) return;
        this.navService.openChannel(channel);
        if (this.voiceChannelSvc.joinedChannelId() !== channel.id) {
            this.voiceChannelSvc.joinChannel(channel, ws.guild.name);
        }
    }

    protected voiceChannelName(channelId: string): string | null {
        const ws = this.navService.workspace();
        if (ws.type !== 'server') return null;
        return ws.guild.channels.find(c => c.id === channelId)?.name ?? null;
    }
}
