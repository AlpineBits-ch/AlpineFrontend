import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    inject,
    input,
    signal,
    untracked,
} from '@angular/core';
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
import {MinuteClockService} from '../../../../services/minute-clock.service';
import {EventCardComponent} from './event-card.component';
import {DayBucket, dayBucket, phaseOf, startTime} from './event-timing';

/** A run of consecutive upcoming events that share a day header. */
export interface EventDayGroup {
    /** Stable `@for` track key: the bucket name for today/tomorrow, the date string otherwise. */
    key: string;
    bucket: DayBucket;
    events: ScheduledEventDto[];
}

@Component({
    selector: 'app-events-panel',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        DatePipe,
        TranslateModule,
        Button,
        Tooltip,
        ConfirmDialog,
        EventEditorDialogComponent,
        EventCardComponent,
    ],
    providers: [ConfirmationService],
    templateUrl: './events-panel.component.html',
})
export class EventsPanelComponent {
    readonly guildId = input.required<string>();
    readonly memberPermissions = input.required<string>();

    protected readonly navService = inject(NavigationService);
    protected readonly store = inject(ScheduledEventStore);
    private readonly profileService = inject(ProfileService);
    private readonly voiceChannelSvc = inject(VoiceChannelService);
    private readonly toastService = inject(ToastService);
    private readonly translate = inject(TranslateService);
    private readonly confirmationService = inject(ConfirmationService);

    // Mirrors ChannelListComponent.canReorder / EmojiSettingsComponent.canManageEmojis: the guild owner short-circuits first (SelfGuildMemberDto.permissions doesn't reliably carry Superadmin for owners), then Superadmin, then the specific bit.
    protected readonly canManage = computed(() => {
        const ws = this.navService.workspace();
        const ownUserId = this.profileService.ownProfile()?.userId;
        if (
            ws.type === 'server' &&
            ws.guild.id === this.guildId() &&
            ownUserId &&
            ownUserId === ws.guild.ownerId
        ) {
            return true;
        }
        const perms = parsePermissions(this.memberPermissions());
        return hasPermission(perms, Permissions.Superadmin) || hasPermission(perms, Permissions.ManageEvents);
    });

    // One shared clock rather than a per-component interval: the sidebar's Events row and every voice channel row read the same signal. See MinuteClockService for why ActivityTickerService can't be reused for timestamps that are in the future.
    protected readonly clock = inject(MinuteClockService);

    // The server never advances an event's status past Scheduled except via cancel (and cancelled events are excluded from the list entirely), so live vs over is derived from the timestamps, never from `status`. That derivation lives in ./event-timing; this component only decides which list each phase goes in.
    private readonly events = computed(() => this.store.eventsForGuild(this.guildId()));

    // Most recently started first: the thing that just began is the thing you are looking for.
    protected readonly live = computed(() =>
        this.events()
            .filter(e => phaseOf(e, this.clock.now()) === 'live')
            .sort((a, b) => startTime(b) - startTime(a)),
    );

    // `events()` is already ascending by start, and filter preserves order.
    protected readonly upcoming = computed(() =>
        this.events().filter(e => phaseOf(e, this.clock.now()) === 'upcoming'),
    );

    protected readonly past = computed(() =>
        this.events()
            .filter(e => phaseOf(e, this.clock.now()) === 'past')
            .reverse(),
    );

    /** Upcoming events cut into day groups. Grouping consecutive runs is only correct because `upcoming()` is sorted ascending by start, which it is, from the store. */
    protected readonly upcomingGroups = computed<EventDayGroup[]>(() => {
        const now = this.clock.now();
        const groups: EventDayGroup[] = [];

        for (const event of this.upcoming()) {
            const bucket = dayBucket(event.startsAt, now);
            const key = bucket === 'later' ? new Date(event.startsAt).toDateString() : bucket;
            const last = groups.at(-1);

            if (last?.key === key) last.events.push(event);
            else groups.push({key, bucket, events: [event]});
        }

        return groups;
    });

    // Load state, so the panel never claims "no upcoming events" while the request is still in flight or after it failed.
    protected readonly isLoading = computed(() => this.store.loading(this.guildId()));
    protected readonly showLoading = computed(() => this.isLoading() && this.events().length === 0);
    protected readonly showError = computed(
        () => !this.isLoading() && this.store.loadError(this.guildId()) && this.events().length === 0,
    );
    protected readonly showEmpty = computed(
        () =>
            !this.showLoading() &&
            !this.showError() &&
            this.live().length === 0 &&
            this.upcoming().length === 0,
    );

    protected readonly showPast = signal(false);
    protected readonly editorVisible = signal(false);
    protected readonly editingEvent = signal<ScheduledEventDto | null>(null);

    constructor() {
        this.clock.retain();

        // `loadFor` reads AND patches loadingGuilds/loadedGuilds internally: tracking only `guildId()` here (and calling loadFor untracked) keeps this effect from re-running itself into a request storm off the store's own state changes.
        effect(() => {
            const id = this.guildId();
            untracked(() => this.store.loadFor(id));
        });

        // No websocket subscriptions here on purpose: ScheduledEventStore's own onInit hook already subscribes to eventCreated/eventUpdated/eventCancelled and dispatches to the same store methods.
    }

    protected retry(): void {
        this.store.loadFor(this.guildId());
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
                    error: err =>
                        this.toastService.httpError(this.translate.instant('EVENTS.CANCEL_ERROR'), err),
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
            void this.voiceChannelSvc.joinChannel(channel, ws.guild.name);
        }
    }
}
