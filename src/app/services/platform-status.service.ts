import {computed, effect, inject, Injectable, signal} from '@angular/core';
import {StatusApiService} from './status-api.service';
import {ConnectionState, RealtimeConnectionService} from './realtime-connection.service';
import {
    IncidentDto,
    IncidentUpdatedDto,
    StatusBannerDto,
    StatusComponentDto,
    StatusIndicator,
    StatusSummaryDto,
} from '../dtos/response/status.dto';

/** Poll interval while the window is in the foreground. The server caches the response for 15 s. */
const POLL_INTERVAL_MS = 60_000;

/** Consecutive failed summary calls before the "we could not check" bar appears. */
const UNVERIFIED_AFTER_FAILURES = 2;

/** How soon the first failure is retried, so the bar is not a full poll interval late. */
const CONFIRM_FAILURE_DELAY_MS = 5_000;

/**
 * How long the socket may stay down before it counts as a failed first reconnect. SignalR gives no
 * per-attempt callback, so the state signal plus this delay is the only reading available; retries
 * go out at 1 s and 2 s, so still disconnected at 4 s means at least one attempt was lost.
 */
const RECONNECT_PROBE_DELAY_MS = 4_000;

const DISMISSED_KEY = 'alpine.status.dismissed';

/** The synthetic dismissal reference for the "could not verify" bar, which has no incident. */
export const UNVERIFIED_REFERENCE = '__unverified__';

/** What the top-of-app bar should render right now. */
export type StatusBarKind = 'incident' | 'unverified';

interface Dismissal {
    reference: string;
    /** The `postedAt` of the newest update at the time of dismissal. */
    version: string;
}

/**
 * "Is it me, or is it them", held for the whole app, signed in or not. One
 * {@link StatusApiService.summary} call drives the banner, the settings page and the per-feature
 * hints, polled only while the window is in the foreground.
 *
 * Deliberate deviation from the platform spec: where the spec says render nothing when the status
 * call fails, this shows a dismissible "could not verify" bar after
 * {@link UNVERIFIED_AFTER_FAILURES} failures. Every failure counts the same, `404` included; a
 * `404` must never be special-cased into silence.
 */
@Injectable({providedIn: 'root'})
export class PlatformStatusService {
    private readonly api = inject(StatusApiService);
    private readonly realtime = inject(RealtimeConnectionService);

    /** Last summary the server gave us, or null before the first success. */
    readonly summary = signal<StatusSummaryDto | null>(null);

    /** `operational` until told otherwise: an unknown state is never rendered as an outage. */
    readonly indicator = computed<StatusIndicator>(() => this.summary()?.indicator ?? 'operational');

    readonly components = computed<StatusComponentDto[]>(() => this.summary()?.components ?? []);

    /** The server's own copy, or null when there is nothing to say. Never composed here. */
    readonly banner = computed<StatusBannerDto | null>(() => this.summary()?.banner ?? null);

    /** True once the server has stopped answering the one endpoint that always should. */
    readonly unverified = computed(() => this.consecutiveFailures() >= UNVERIFIED_AFTER_FAILURES);

    private readonly consecutiveFailures = signal(0);
    private readonly dismissed = signal<Dismissal | null>(readDismissal());
    private timer: ReturnType<typeof setInterval> | null = null;
    private confirmTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectProbe: ReturnType<typeof setTimeout> | null = null;
    private started = false;
    private inFlight = false;

    constructor() {
        // The dependency must point this way: `RealtimeConnectionService` reaches `AuthService`,
        // so a callback in the other direction closes an injection cycle.
        let wasConnected = false;
        effect(() => {
            const state = this.realtime.connectionState();
            if (state === ConnectionState.Connected) {
                wasConnected = true;
                this.clearReconnectProbe();
                return;
            }
            // Only a drop counts: a signed-out client never connects the hub, and its permanent
            // `Disconnected` would otherwise probe on every visit to the login screen.
            if (!wasConnected) return;
            wasConnected = false;
            if (this.reconnectProbe !== null) return;
            this.reconnectProbe = setTimeout(() => {
                this.reconnectProbe = null;
                if (this.realtime.connectionState() !== ConnectionState.Connected) this.probe();
            }, RECONNECT_PROBE_DELAY_MS);
        });
    }

    /** What the top-of-app bar renders, or null. A real incident outranks "we could not check". */
    readonly bar = computed<StatusBarKind | null>(() => {
        const banner = this.banner();
        // Driven off the banner's presence, never `indicator !== 'operational'`: an indicator value
        // this build has never heard of must not decide whether the user sees a bar.
        if (banner && !this.isDismissed(banner.incidentReference, this.bannerVersion())) {
            return 'incident';
        }
        if (banner) return null;
        if (this.unverified() && !this.isDismissed(UNVERIFIED_REFERENCE, '')) return 'unverified';
        return null;
    });

    /**
     * `postedAt` of the newest update on the banner's incident: the half of the dismissal key that
     * re-shows the bar when a new update lands on an already-dismissed incident.
     */
    readonly bannerVersion = computed(() => {
        const reference = this.banner()?.incidentReference;
        if (!reference) return '';
        const incident = this.findIncident(reference);
        return incident?.updates?.[0]?.postedAt ?? incident?.startedAt ?? incident?.scheduledFor ?? '';
    });

    /** Starts foreground polling. Idempotent; safe to call from app bootstrap. */
    start(): void {
        if (this.started) return;
        this.started = true;

        document.addEventListener('visibilitychange', this.onVisibilityChange);
        this.wireRealtime();
        this.refresh();
        this.scheduleTimer();
    }

    /** Stops polling and detaches listeners. Exists for teardown in tests. */
    stop(): void {
        this.started = false;
        this.clearTimer();
        this.clearConfirmTimer();
        this.clearReconnectProbe();
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }

    /**
     * One out-of-band fetch, for the moments the user is already looking at something broken.
     * Cheap to over-call: a fetch already in flight wins and this returns immediately.
     */
    probe(): void {
        this.refresh();
    }

    /**
     * Hides the current bar until it becomes new information again. Keyed on the incident reference
     * and the newest update's timestamp, so a later update brings the bar back.
     */
    dismiss(): void {
        const kind = this.bar();
        if (kind === 'unverified') {
            this.writeDismissal({reference: UNVERIFIED_REFERENCE, version: ''});
            return;
        }
        const banner = this.banner();
        if (!banner) return;
        this.writeDismissal({reference: banner.incidentReference, version: this.bannerVersion()});
    }

    /** The component's status, or null when this build has never heard of the key. */
    componentStatus(key: string): StatusComponentDto | null {
        return this.components().find(c => c.key === key) ?? null;
    }

    /**
     * Whether a named subsystem is having trouble, for the optional per-feature hints. Answers
     * `false` for a key the server does not send, so a renamed component degrades to silence.
     */
    isComponentDegraded(key: string): boolean {
        const component = this.componentStatus(key);
        return component !== null && component.status !== 'operational';
    }

    private refresh(): void {
        if (this.inFlight) return;
        this.inFlight = true;

        this.api.summary().subscribe({
            next: summary => {
                this.inFlight = false;
                this.clearConfirmTimer();
                this.consecutiveFailures.set(0);
                this.applySummary(summary);
            },
            error: () => {
                this.inFlight = false;
                const failures = this.consecutiveFailures() + 1;
                this.consecutiveFailures.set(failures);
                // Every status code counts the same here, `404` included. See the class comment.
                if (failures < UNVERIFIED_AFTER_FAILURES) this.scheduleConfirm();
            },
        });
    }

    /** The quick second opinion after the first failure, so the bar is not a minute late. */
    private scheduleConfirm(): void {
        if (this.confirmTimer !== null) return;
        this.confirmTimer = setTimeout(() => {
            this.confirmTimer = null;
            this.refresh();
        }, CONFIRM_FAILURE_DELAY_MS);
    }

    /** Replaces the cached summary and drops any dismissal whose incident is no longer present. */
    private applySummary(summary: StatusSummaryDto): void {
        this.summary.set(summary);
        this.pruneDismissal();
    }

    /**
     * Merges one incident from `status.IncidentUpdated`. An unseen incident refetches rather than
     * guessing: the summary carries banner copy this event does not.
     */
    private mergeIncident(incident: IncidentDto): void {
        const current = this.summary();
        if (!current) {
            this.refresh();
            return;
        }

        const lists = ['incidents', 'maintenance', 'recent'] as const;
        const listKey = lists.find(key => current[key].some(i => i.reference === incident.reference));
        if (!listKey) {
            this.refresh();
            return;
        }

        this.summary.set({
            ...current,
            [listKey]: current[listKey].map(i => (i.reference === incident.reference ? incident : i)),
        });
    }

    private wireRealtime(): void {
        // A latency improvement, not a replacement for polling: the hub is authenticated, and a
        // signed-out user may be signed out because of the incident.
        this.realtime.on('status.SummaryChanged', (summary: StatusSummaryDto) => {
            this.clearConfirmTimer();
            this.consecutiveFailures.set(0);
            this.applySummary(summary);
        });
        this.realtime.on('status.IncidentUpdated', (payload: IncidentUpdatedDto) => {
            if (payload?.incident) this.mergeIncident(payload.incident);
        });
    }

    private findIncident(reference: string): IncidentDto | null {
        const current = this.summary();
        if (!current) return null;
        for (const list of [current.incidents, current.maintenance, current.recent]) {
            const found = list.find(i => i.reference === reference);
            if (found) return found;
        }
        return null;
    }

    private isDismissed(reference: string, version: string): boolean {
        const dismissal = this.dismissed();
        return dismissal?.reference === reference && dismissal.version === version;
    }

    /** Forgets a dismissal once its incident has left the response, per the spec. */
    private pruneDismissal(): void {
        const dismissal = this.dismissed();
        if (!dismissal) return;
        if (dismissal.reference === UNVERIFIED_REFERENCE) {
            // A successful summary is the whole point of the unverified bar going away.
            this.writeDismissal(null);
            return;
        }
        if (!this.findIncident(dismissal.reference)) this.writeDismissal(null);
    }

    private writeDismissal(dismissal: Dismissal | null): void {
        this.dismissed.set(dismissal);
        try {
            if (dismissal) localStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissal));
            else localStorage.removeItem(DISMISSED_KEY);
        } catch {
            // A storage that refuses to write only costs the dismissal surviving a restart.
        }
    }

    private readonly onVisibilityChange = (): void => {
        if (document.visibilityState === 'visible') {
            this.refresh();
            this.scheduleTimer();
            return;
        }
        this.clearTimer();
    };

    private scheduleTimer(): void {
        this.clearTimer();
        if (document.visibilityState !== 'visible') return;
        this.timer = setInterval(() => this.refresh(), POLL_INTERVAL_MS);
    }

    private clearTimer(): void {
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
    }

    private clearReconnectProbe(): void {
        if (this.reconnectProbe !== null) clearTimeout(this.reconnectProbe);
        this.reconnectProbe = null;
    }

    private clearConfirmTimer(): void {
        if (this.confirmTimer !== null) clearTimeout(this.confirmTimer);
        this.confirmTimer = null;
    }
}

function readDismissal(): Dismissal | null {
    try {
        const raw = localStorage.getItem(DISMISSED_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<Dismissal>;
        if (typeof parsed?.reference !== 'string') return null;
        return {reference: parsed.reference, version: parsed.version ?? ''};
    } catch {
        return null;
    }
}
