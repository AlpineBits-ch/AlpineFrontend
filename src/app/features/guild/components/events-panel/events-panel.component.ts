import {ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, input, signal, untracked} from '@angular/core';
import {DatePipe} from '@angular/common';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Button} from 'primeng/button';
import {ConfirmationService} from 'primeng/api';
import {ConfirmDialog} from 'primeng/confirmdialog';
import {Tooltip} from 'primeng/tooltip';
import {ScheduledEventStore} from '../../../../stores/scheduled-event.store';
import {ScheduledEventDto} from '../../../../dtos/response/scheduled-event.dto';
import {hasPermission, parsePermissions, Permissions} from '../../../../enums/permissions.enum';
import {NavigationService} from '../../../main-page/navigation.service';
import {ProfileService} from '../../../../services/profile.service';
import {VoiceChannelService} from '../../../../services/voice-channel.service';
import {ToastService} from '../../../../services/toast.service';
import {EventEditorDialogComponent} from './event-editor-dialog.component';

@Component({
    selector: 'app-events-panel',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [DatePipe, TranslateModule, Button, Tooltip, ConfirmDialog, EventEditorDialogComponent],
    providers: [ConfirmationService],
    templateUrl: './events-panel.component.html',
})
export class EventsPanelComponent {
    guildId = input.required<string>();
    memberPermissions = input.required<string>();

    protected readonly navService = inject(NavigationService);
    protected readonly store = inject(ScheduledEventStore);
    private readonly profileService = inject(ProfileService);
    private readonly voiceChannelSvc = inject(VoiceChannelService);
    private readonly toastService = inject(ToastService);
    private readonly translate = inject(TranslateService);
    private readonly confirmationService = inject(ConfirmationService);
    private readonly destroyRef = inject(DestroyRef);

    // Mirrors ChannelListComponent.canReorder / EmojiSettingsComponent.canManageEmojis:
    // the guild owner short-circuits first (SelfGuildMemberDto.permissions does not
    // reliably carry Superadmin for owners), then Superadmin, then the specific bit.
    protected canManage = computed(() => {
        const ws = this.navService.workspace();
        const ownUserId = this.profileService.ownProfile()?.userId;
        if (ws.type === 'server' && ws.guild.id === this.guildId() && ownUserId && ownUserId === ws.guild.ownerId) {
            return true;
        }
        const perms = parsePermissions(this.memberPermissions());
        return hasPermission(perms, Permissions.Superadmin) || hasPermission(perms, Permissions.ManageEvents);
    });

    // `Date.now()` isn't itself a reactive read, so a computed that only calls it
    // directly would never re-evaluate as time passes -it'd need some *other* signal
    // to change first to notice an event had ended. This local clock is that signal:
    // a plain `signal<number>`, ticked by a 60s interval (minute-granularity UI, no
    // need to poll faster), read by `upcoming`/`past` below so they recompute on their
    // own. It never touches the store and can't trigger `loadFor` or any HTTP call.
    private readonly now = signal(Date.now());
    private readonly nowIntervalId = setInterval(() => this.now.set(Date.now()), 60_000);

    // The server never advances an event's status past Scheduled except via cancel
    // (and cancelled events are excluded from the list entirely) -so "happening" vs
    // "over" must be derived from the timestamps, never from `status`.
    private readonly events = computed(() => this.store.eventsForGuild(this.guildId()));
    protected upcoming = computed(() =>
        this.events().filter(e => this.endBoundary(e) >= this.now()));
    protected past = computed(() =>
        this.events()
            .filter(e => this.endBoundary(e) < this.now())
            .slice()
            .reverse());

    // Load state, so the panel never claims "no upcoming events" while the request is
    // still in flight or after it failed.
    protected isLoading = computed(() => this.store.loading(this.guildId()));
    protected showLoading = computed(() => this.isLoading() && this.events().length === 0);
    protected showError = computed(() =>
        !this.isLoading() && this.store.loadError(this.guildId()) && this.events().length === 0);
    protected showEmpty = computed(() =>
        !this.showLoading() && !this.showError() && this.upcoming().length === 0);

    protected showPast = signal(false);
    protected editorVisible = signal(false);
    protected editingEvent = signal<ScheduledEventDto | null>(null);

    constructor() {
        this.destroyRef.onDestroy(() => clearInterval(this.nowIntervalId));

        // `loadFor` reads AND patches loadingGuilds/loadedGuilds internally -tracking
        // only `guildId()` here (and calling loadFor untracked) keeps this effect from
        // re-running itself into a request storm off the store's own state changes.
        effect(() => {
            const id = this.guildId();
            untracked(() => this.store.loadFor(id));
        });

        // No websocket subscriptions here on purpose: ScheduledEventStore's own onInit
        // hook already subscribes to eventCreated/eventUpdated/eventCancelled and
        // dispatches to the exact same store methods. Duplicating them here only worked
        // because the store's hook happened to run first.
    }

    protected retry(): void {
        this.store.loadFor(this.guildId());
    }

    /**
     * Epoch ms at which an event counts as over: its end when present and parseable,
     * otherwise its start. A blank or unparseable `endsAt` must fall back to `startsAt` -
     * a bare `new Date('')` yields NaN, and NaN compares false both ways, silently
     * dropping the event from the upcoming *and* past lists.
     */
    private endBoundary(event: ScheduledEventDto): number {
        const end = event.endsAt ? new Date(event.endsAt).getTime() : Number.NaN;
        return Number.isNaN(end) ? new Date(event.startsAt).getTime() : end;
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
