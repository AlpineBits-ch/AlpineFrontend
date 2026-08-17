import type {
    PublicationStats,
    RemoteLevel,
    SourceStats,
    SpatialModel,
    VoicePosition,
    VoiceSession,
    VoiceStats,
    VoiceTarget,
} from '../../services/voice-engine.service';

/**
 * The existing voice types, unchanged and re-exported.
 *
 * Must stay `import type`: a value import would pull the Tauri IPC module into the web bundle.
 */
export type {
    PublicationStats,
    RemoteLevel,
    SourceStats,
    SpatialModel,
    VoicePosition,
    VoiceSession,
    VoiceStats,
    VoiceTarget,
};

/**
 * The bottom of the meter's scale, and what a level reads before any audio has arrived.
 *
 * Lives here, not in `voice-engine.service.ts`: an adapter must not import a value from the
 * service it backs.
 */
export const SILENCE_DBFS = -100;

/**
 * What the engine reports while a session runs. The only declaration of the shape.
 *
 * Field names are the Rust `VoiceEvent`'s, deserialised by name, so a rename breaks it silently.
 */
export interface VoicePublisherEvent {
    kind: 'speaking' | 'levels' | 'error';
    speaking: boolean;
    level: number;
    /** Capture level in dBFS, and where the gate currently opens. Both on `kind: 'speaking'`. */
    levelDb: number;
    thresholdDb: number;
    message?: string;
    levels?: RemoteLevel[];
}

/**
 * Everything needed to open one publication.
 *
 * `deviceId` must be the same value the webview's `X-Device-Id` header carries, or one user is
 * split across two device buckets.
 */
export interface VoiceStartOptions {
    target: VoiceTarget;
    apiBase: string;
    token: string;
    deviceId: string;
    /**
     * The SFU connection this publication should use, fetched by the caller. Absent means Isle.
     *
     * This is the primary connection (`?primary=true`, no tag). It must never be the same one the
     * webview opens for itself, or the SFU disconnects one of the two.
     */
    livekit?: {url: string; token: string};
    /** How the engine reports speaking, levels and errors for the life of this session. */
    onEvent?(event: VoicePublisherEvent): void;
}

/**
 * Capture processing, as both hosts must accept it.
 *
 * Field names must match the Rust `VoiceSettings` exactly; it is deserialised by name.
 */
export interface VoiceProcessing {
    /** Null means "the host default", not "no device". */
    deviceId: string | null;
    outputDeviceId: string | null;
    noiseSuppression: 'none' | 'standard' | 'enhanced';
    echoCancellation: boolean;
    autoGainControl: boolean;
    inputMode: 'ptt' | 'voice';
    /** 0.0-1.0, where 1.0 is permissive. The inverse of the UI's cutoff slider. */
    sensitivity: number;
    /** 0.0-1.0 gains. */
    inputVolume: number;
    outputVolume: number;
    bitrateBps: number | null;
}

/**
 * Where one participant is, relative to the listener.
 *
 * `position: null` un-places the source, leaving it centred at full volume.
 */
export interface Position {
    id: string;
    position: VoicePosition | null;
}

/**
 * Publishing a microphone into a call. The publish half only; playout stays in the webview.
 *
 * Methods taking a {@link VoiceSession} address one call; the rest address the hardware.
 */
export abstract class VoicePublisher {
    abstract start(o: VoiceStartOptions): Promise<VoiceSession>;

    abstract stop(s: VoiceSession): Promise<void>;

    /**
     * Pull a participant's audio into the mix. `id` keys volume, levels and unsubscribe.
     *
     * Must reject rather than resolve quietly on failure: nothing retries a subscribe.
     */
    abstract subscribe(s: VoiceSession, id: string, mediaSessionId: string, trackName: string): Promise<void>;

    abstract unsubscribe(s: VoiceSession, id: string): Promise<void>;

    /** Open or close the microphone *for one call*. Proximity PTT must not also key the guild channel. */
    abstract setPttOpen(s: VoiceSession, open: boolean): Promise<void>;

    /** Mute the microphone itself, for every call at once. A statement about the hardware, not a call. */
    abstract setMute(muted: boolean): Promise<void>;

    abstract setDeafened(deafened: boolean): Promise<void>;

    /** Per-source volume, 0.0-1.0. `userId` is the same key {@link subscribe} was given. */
    abstract setUserVolume(userId: string, volume: number): Promise<void>;

    abstract setProcessing(p: VoiceProcessing): Promise<void>;

    abstract setSpatialModel(m: SpatialModel): Promise<void>;

    abstract setPosition(p: Position): Promise<void>;

    /**
     * A snapshot of every counter in the pipeline. Read two a second apart; the deltas are the signal.
     *
     * Non-nullable: an adapter with nothing running answers zeroed counters and `running: false`.
     */
    abstract stats(): Promise<VoiceStats>;

    /** Web-only: VAD replaces PTT because global hotkeys cannot exist. */
    abstract readonly supportsVad: boolean;
}
