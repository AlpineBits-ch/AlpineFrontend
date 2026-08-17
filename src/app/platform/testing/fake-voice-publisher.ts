import {
    Position,
    SILENCE_DBFS,
    SpatialModel,
    VoicePosition,
    VoicePublisher,
    VoicePublisherEvent,
    VoiceProcessing,
    VoiceSession,
    VoiceStartOptions,
    VoiceStats,
} from '../ports/voice-publisher.port';

/** Zeroed counters and nothing running, which is what an idle engine reports. */
export function idleVoiceStats(overrides: Partial<VoiceStats> = {}): VoiceStats {
    return {
        running: false,
        framesCaptured: 0,
        captureRms: 0,
        packetsEncoded: 0,
        muted: false,
        gateOpen: false,
        playoutFrames: 0,
        mixRms: 0,
        deafened: false,
        masterVolume: 1,
        sources: [],
        publications: [],
        ...overrides,
    };
}

/** One recorded subscribe, as the port saw it. */
export interface RecordedSubscribe {
    slot: string;
    id: string;
    mediaSessionId: string;
    trackName: string;
}

/**
 * A {@link VoicePublisher} for specs, provided in TestBed in place of an adapter.
 *
 * <p>Touches <b>no microphone and no network</b>: no `getUserMedia`, no `RTCPeerConnection`, no IPC. That
 * is what makes it safe to provide by default to every spec whose injector graph happens to reach voice -
 * which is most of them, because the call and websocket services sit in the middle of the app.</p>
 *
 * <p>Calls are recorded as `[method, ...args]` in {@link calls}, the convention `FakePresence` and
 * `FakeWindowChrome` established, because the assertions about this port are nearly always "how many
 * times, and with what". The state that a caller <i>reads back</i> - mute, deafen, per-user volume,
 * positions - is also kept as fields, so a spec can assert what the engine ended up holding rather than
 * replaying the call log to work it out.</p>
 *
 * <p>{@link emit} is the part a module mock could not do: it fires the event channel `start` was handed, so
 * speaking transitions and remote levels - every meter in the app - are reachable from a test. The
 * defaults come from {@link SILENCE_DBFS}, deliberately: a level of `undefined` turns every comparison into
 * `NaN`, and for a capture gate that means permanently open or permanently shut with nothing logged.</p>
 */
export class FakeVoicePublisher extends VoicePublisher {
    /** Mutable so one spec covers both hosts. True is the browser: VAD stands in for a global hotkey. */
    supportsVad = false;

    /** Every call, as `[method, ...args]`. */
    readonly calls: unknown[][] = [];

    /** Every session started, in order. Handed back to the caller and used as its own identity. */
    readonly sessions: VoiceSession[] = [];

    /** The options each {@link start} was given, in order. */
    readonly startOptions: VoiceStartOptions[] = [];

    /** Slots stopped, in order. */
    readonly stopped: string[] = [];

    /** Every subscribe, in order. `id` is the key volume, levels and unsubscribe are addressed by. */
    readonly subscribed: RecordedSubscribe[] = [];

    /** Every unsubscribe, as `[slot, id]`. */
    readonly unsubscribed: [string, string][] = [];

    /** Whether the microphone is open, per slot. PTT is per call; muting is not. */
    readonly pttOpen = new Map<string, boolean>();

    /** The hardware state, which spans every call at once. */
    muted = false;
    deafened = false;

    /** Per-source volume, 0.0-1.0, keyed as {@link subscribe} was. */
    readonly userVolumes = new Map<string, number>();

    /** The last processing settings applied, or null if none were. */
    processing: VoiceProcessing | null = null;

    /** The last spatial model applied, or null. */
    spatialModel: SpatialModel | null = null;

    /** Where each source was last placed. A null value un-places it, which is the only spatial switch. */
    readonly positions = new Map<string, VoicePosition | null>();

    /** What {@link stats} answers. Non-nullable, like the port: an idle engine reports zeroes. */
    statsSnapshot: VoiceStats = idleVoiceStats();

    /** Set to make {@link start} reject - no device, or an SFU that refused the publication. */
    startError: Error | null = null;

    /**
     * Set to make {@link subscribe} reject.
     *
     * <p>The port requires a rejection rather than a quiet resolve, because nothing retries a subscribe: a
     * swallowed failure is a participant who stays silent for the rest of the session.</p>
     */
    subscribeError: Error | null = null;

    private nextSlot = 1;
    private readonly listeners = new Map<string, (event: VoicePublisherEvent) => void>();

    async start(options: VoiceStartOptions): Promise<VoiceSession> {
        this.calls.push(['start', options.target]);
        this.startOptions.push(options);
        if (this.startError) throw this.startError;

        const index = this.nextSlot++;
        const session: VoiceSession = {
            slot: `slot-${index}`,
            mediaSessionId: `media-session-${index}`,
            trackName: `voice-${index}`,
        };
        this.sessions.push(session);
        if (options.onEvent) this.listeners.set(session.slot, options.onEvent);
        return session;
    }

    async stop(session: VoiceSession): Promise<void> {
        this.calls.push(['stop', session.slot]);
        this.stopped.push(session.slot);
        this.listeners.delete(session.slot);
        this.pttOpen.delete(session.slot);
    }

    async subscribe(
        session: VoiceSession,
        id: string,
        mediaSessionId: string,
        trackName: string,
    ): Promise<void> {
        this.calls.push(['subscribe', session.slot, id, mediaSessionId, trackName]);
        this.subscribed.push({slot: session.slot, id, mediaSessionId, trackName});
        if (this.subscribeError) throw this.subscribeError;
    }

    async unsubscribe(session: VoiceSession, id: string): Promise<void> {
        this.calls.push(['unsubscribe', session.slot, id]);
        this.unsubscribed.push([session.slot, id]);
    }

    async setPttOpen(session: VoiceSession, open: boolean): Promise<void> {
        this.calls.push(['setPttOpen', session.slot, open]);
        this.pttOpen.set(session.slot, open);
    }

    async setMute(muted: boolean): Promise<void> {
        this.calls.push(['setMute', muted]);
        this.muted = muted;
    }

    async setDeafened(deafened: boolean): Promise<void> {
        this.calls.push(['setDeafened', deafened]);
        this.deafened = deafened;
    }

    async setUserVolume(userId: string, volume: number): Promise<void> {
        this.calls.push(['setUserVolume', userId, volume]);
        this.userVolumes.set(userId, volume);
    }

    async setProcessing(processing: VoiceProcessing): Promise<void> {
        this.calls.push(['setProcessing', processing]);
        this.processing = processing;
    }

    async setSpatialModel(model: SpatialModel): Promise<void> {
        this.calls.push(['setSpatialModel', model]);
        this.spatialModel = model;
    }

    async setPosition(position: Position): Promise<void> {
        this.calls.push(['setPosition', position]);
        this.positions.set(position.id, position.position);
    }

    async stats(): Promise<VoiceStats> {
        this.calls.push(['stats']);
        return this.statsSnapshot;
    }

    /**
     * Fires an engine event on a session's channel.
     *
     * <p>Defaults to a silent, not-speaking `levels`-free `speaking` report, so a spec states only the
     * field it is about. Throws when the session has no listener rather than passing quietly: an assertion
     * about a meter nobody subscribed to would otherwise pass while proving nothing.</p>
     */
    emit(session: VoiceSession, event: Partial<VoicePublisherEvent> = {}): void {
        const listener = this.listeners.get(session.slot);
        if (!listener) throw new Error(`nothing is listening on '${session.slot}'`);
        listener({
            kind: 'speaking',
            speaking: false,
            level: 0,
            levelDb: SILENCE_DBFS,
            thresholdDb: SILENCE_DBFS,
            ...event,
        });
    }

    /** Whether a session's event channel is still live - a stop removes it. */
    hasListener(session: VoiceSession): boolean {
        return this.listeners.has(session.slot);
    }

    /** Every call to `method`, as its argument list. */
    callsTo(method: string): unknown[][] {
        return this.calls.filter(call => call[0] === method).map(call => call.slice(1));
    }
}
