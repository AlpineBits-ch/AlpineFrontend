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
 * <p>`import type` on purpose. `voice-engine.service.ts` imports `@tauri-apps/api/core` for values,
 * and a value import here would pull the Tauri IPC module into the web bundle through the very file
 * whose job is to keep it out. A type-only import is erased entirely, so this port has no runtime
 * dependency on the service at all - which is also what makes the eventual cycle harmless when
 * `VoiceEngineService` starts depending on this port.</p>
 *
 * <p>Declared there rather than moved here because the shapes mirror Rust structs field-for-field
 * (`VoiceStats`, `PublicationStats`, `SourceStats` are deserialised by name) and moving them would
 * touch every existing caller for no gain.</p>
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
 * <p>Declared here rather than in `voice-engine.service.ts`, where it used to live, because both
 * adapters need it and <b>an adapter must not import a value from the service it backs</b>. That would
 * be acyclic today and a trap tomorrow: a module-scope const initialised from across a cycle silently
 * evaluates to `undefined`, and a dBFS floor of `undefined` turns every level comparison into `NaN` -
 * which for a capture gate means permanently open or permanently shut, with nothing logged either way.
 * The service re-exports this so its existing importers are unaffected.</p>
 */
export const SILENCE_DBFS = -100;

/**
 * What the engine reports while a session runs.
 *
 * <p>Declared here because the design spec's `VoicePublisher` surface has no event channel of its
 * own, and a publisher that cannot report speaking or remote levels would silence every meter in the
 * app.</p>
 *
 * <p><b>This is the only declaration of the shape.</b> `voice-engine.service.ts` used to carry a
 * private `VoiceEvent` mirroring it for its `Channel<VoiceEvent>`; that copy is gone and the service
 * imports this one, because two declarations of one wire shape drift and the failure is silent - the
 * Rust `VoiceEvent` is serialised by field name, so a field renamed on one copy is a meter that stops
 * moving rather than an error anyone sees.</p>
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
 * <p>The design spec names this type in `start(o: VoiceStartOptions)` without defining it, so the
 * shape is taken from the four arguments `VoiceEngineService.start` already takes, plus `onEvent`
 * for the reason given on {@link VoicePublisherEvent}.</p>
 *
 * <p>`apiBase`, `token` and `deviceId` are passed in rather than read by the adapter, matching how
 * the screen publisher is called: neither adapter owns session lifetime or token refresh.
 * `deviceId` must be the same value the webview's `X-Device-Id` header carries - this is the
 * *primary* session, so a mismatch splits one user across two device buckets with their microphone
 * in the wrong one.</p>
 */
export interface VoiceStartOptions {
    target: VoiceTarget;
    apiBase: string;
    token: string;
    deviceId: string;
    /** How the engine reports speaking, levels and errors for the life of this session. */
    onEvent?(event: VoicePublisherEvent): void;
}

/**
 * Capture processing, as both hosts must accept it.
 *
 * <p>Field names match the Rust `VoiceSettings` exactly, because the Tauri adapter forwards this
 * straight to `voice_set_processing` where it is deserialised by name - a rename here is a setting
 * that silently stops working rather than an error anyone sees. The web adapter maps the same fields
 * onto `applyConstraints` (`echoCancellation`, `noiseSuppression`, `autoGainControl`) and onto its
 * own gain and gate.</p>
 *
 * <p>`sensitivity` runs the opposite way to the UI's `voiceThreshold` cutoff, and the inversion
 * stays where it already is - in the voice service, once - rather than being duplicated per
 * adapter.</p>
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
 * <p>The design spec gives `setPosition(p: Position)` - one argument, no participant id. Taken
 * literally that cannot address the per-source position table the mixer keeps, so `Position` carries
 * the id: the signature is the spec's, and the id it needs travels inside it. `position: null`
 * un-places the source, which is the only spatial switch there is - a source with no position is
 * centred at full volume, which is exactly what a guild participant wants.</p>
 */
export interface Position {
    id: string;
    position: VoicePosition | null;
}

/**
 * Publishing a microphone into a call.
 *
 * <p>Mirrors `VoiceEngineService`'s existing surface. The split between the methods that take a
 * {@link VoiceSession} and those that do not is the whole model: a session addresses one call,
 * everything else addresses the hardware. Muting the microphone is not something you do to a
 * call.</p>
 *
 * <p>Receive is <b>not</b> here. Playout already happens in the webview on both hosts and stays
 * there - see `project_video_receive_stays_in_webview`. This port is the publish half only.</p>
 */
export abstract class VoicePublisher {
    abstract start(o: VoiceStartOptions): Promise<VoiceSession>;

    abstract stop(s: VoiceSession): Promise<void>;

    /**
     * Pull a participant's audio into the mix.
     *
     * <p>`id` is the key for volume, levels and unsubscribe, and is unique across calls - which is
     * what lets one mixer serve them all. Voice uses the user id; a stream's audio uses its track
     * name, so muting someone's stream does not also mute their voice.</p>
     *
     * <p>Must reject rather than resolve quietly on failure: nothing retries a subscribe, so a
     * swallowed error is a participant who stays silent for the rest of the session.</p>
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
     * A snapshot of every counter in the pipeline.
     *
     * <p>Read two a second apart - the deltas are the signal, the totals are not. Per-entity
     * counters beat aggregates here; see `project_voice_screenshare_followups`.</p>
     *
     * <p>Non-nullable, unlike `VoiceEngineService.stats()` which returns null outside Tauri. An
     * adapter with nothing running answers with zeroed counters and `running: false`, so a caller
     * never has to tell "no engine" from "engine idle" before it can render a number.</p>
     */
    abstract stats(): Promise<VoiceStats>;

    /** Web-only: VAD replaces PTT because global hotkeys cannot exist. */
    abstract readonly supportsVad: boolean;
}
