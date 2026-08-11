import {Injectable} from '@angular/core';
import {
    Position,
    SpatialModel,
    VoiceProcessing,
    VoicePublisher,
    VoicePublisherEvent,
    VoiceSession,
    VoiceStartOptions,
    VoiceStats,
} from '../ports/voice-publisher.port';

/**
 * The Rust voice engine, as a {@link VoicePublisher}.
 *
 * <p>A thin wrapper over the `voice_*` commands and nothing else. Every payload below is the one
 * `VoiceEngineService` used to build inline, field for field: the Rust structs are deserialised
 * <b>by name</b>, so a rename here is a setting that silently stops working rather than an error
 * anyone sees. Nothing is reordered, nothing is defaulted, and no argument is dropped even where the
 * Rust side would tolerate its absence.</p>
 *
 * <p>The IPC module is `import()`ed on first use rather than at construction, so a browser build never
 * pulls `@tauri-apps/api` into its startup path - see the note on `providePlatform`. Cached after the
 * first call: `import()` memoises, but holding the promise makes the "one module, however many calls"
 * property local rather than a fact about the loader.</p>
 */
@Injectable()
export class TauriVoicePublisher extends VoicePublisher {
    /**
     * False, because the desktop host has a real global hotkey.
     *
     * <p>Not "the engine cannot gate on speech" - it has had a voice-activity gate all along, in
     * `gate.rs`, selected by `inputMode: 'voice'`. What this flag means is "VAD has to stand in for
     * push-to-talk because no key can be delivered while another application has focus", and on
     * desktop it does not.</p>
     */
    readonly supportsVad = false;

    private core: Promise<typeof import('@tauri-apps/api/core')> | null = null;

    /**
     * The most recent processing payload, because `voice_start` takes one and the port's
     * `start` does not carry it.
     *
     * <p>`voice_start` needs the settings up front for a reason: they choose the input and output
     * devices the engine opens, and the gate mode that decides whether a fresh publication starts open
     * (`starts_open` in `session.rs`). So the delegate pushes settings through {@link setProcessing}
     * immediately before starting, and this is where they wait.</p>
     */
    private processing: VoiceProcessing | null = null;

    /**
     * Slots with a publication on them, so {@link setProcessing} can tell "cache this" from "apply
     * this to a running engine".
     *
     * <p>That distinction is the whole reason this set exists. `voice_set_processing` on a running
     * engine calls `Engine::set_config`, which <b>reopens or closes every publication</b> according to
     * the gate mode - so sending it while a guild call is up would reset that call's push-to-talk
     * state. Rust no-ops the command when no engine exists, so forwarding it while idle would be
     * harmless but pointless; forwarding it on every join would not be.</p>
     */
    private readonly running = new Set<string>();

    async start(o: VoiceStartOptions): Promise<VoiceSession> {
        const {Channel, invoke} = await this.tauri();

        const channel = new Channel<VoicePublisherEvent>();
        channel.onmessage = event => o.onEvent?.(event);

        const session = await invoke<VoiceSession>('voice_start', {
            settings: this.settingsPayload(),
            // None, deliberately. Cloudflare's SFU is publicly routable, so host candidates reach it
            // and it answers to whatever source address it sees - which is why the DM call path has
            // never passed any either. Passing STUN servers here, copied from the screen publisher,
            // bought nothing and added the one step in ICE gathering that can block on the network.
            iceServers: [],
            apiBase: o.apiBase,
            token: o.token,
            deviceId: o.deviceId,
            guildId: o.target.kind === 'guild' ? o.target.guildId : null,
            channelId: o.target.kind === 'guild' ? o.target.channelId : null,
            callId: o.target.kind === 'call' ? o.target.callId : null,
            // Isle addresses no channel or call, so it is flagged rather than identified.
            isle: o.target.kind === 'isle',
            onEvent: channel,
        });

        this.running.add(session.slot);
        return session;
    }

    async stop(s: VoiceSession): Promise<void> {
        this.running.delete(s.slot);
        const {invoke} = await this.tauri();
        await invoke('voice_stop', {slot: s.slot});
    }

    async subscribe(s: VoiceSession, id: string, mediaSessionId: string, trackName: string): Promise<void> {
        const {invoke} = await this.tauri();
        await invoke('voice_subscribe', {slot: s.slot, id, mediaSessionId, trackName});
    }

    async unsubscribe(s: VoiceSession, id: string): Promise<void> {
        const {invoke} = await this.tauri();
        await invoke('voice_unsubscribe', {slot: s.slot, id});
    }

    async setPttOpen(s: VoiceSession, open: boolean): Promise<void> {
        const {invoke} = await this.tauri();
        await invoke('voice_set_ptt_open', {slot: s.slot, open});
    }

    async setMute(muted: boolean): Promise<void> {
        const {invoke} = await this.tauri();
        await invoke('voice_set_mute', {muted});
    }

    async setDeafened(deafened: boolean): Promise<void> {
        const {invoke} = await this.tauri();
        await invoke('voice_set_deafened', {deafened});
    }

    async setUserVolume(userId: string, volume: number): Promise<void> {
        const {invoke} = await this.tauri();
        await invoke('voice_set_user_volume', {id: userId, volume});
    }

    /**
     * Cache the settings, and apply them only to an engine that is already running.
     *
     * <p>See {@link running} for why the guard is not "always forward". Deduplicated on the payload
     * as well: the delegate pushes settings before every start, and a push that changes nothing must
     * not reach `Engine::set_config`, which would reopen or close every publication for no reason.</p>
     */
    async setProcessing(p: VoiceProcessing): Promise<void> {
        const unchanged = this.processing !== null
            && JSON.stringify(this.processing) === JSON.stringify(p);
        this.processing = p;
        if (unchanged || this.running.size === 0) return;

        const {invoke} = await this.tauri();
        await invoke('voice_set_processing', {settings: p});
    }

    async setSpatialModel(m: SpatialModel): Promise<void> {
        const {invoke} = await this.tauri();
        // Flattened rather than passed as an object: the command takes four scalars.
        await invoke('voice_set_spatial_model', {
            refDistance: m.refDistance,
            rolloff: m.rolloff,
            maxDistance: m.maxDistance,
            intensity: m.intensity,
        });
    }

    async setPosition(p: Position): Promise<void> {
        const {invoke} = await this.tauri();
        await invoke('voice_set_position', {
            id: p.id,
            x: p.position?.x ?? null,
            y: p.position?.y ?? null,
            z: p.position?.z ?? null,
        });
    }

    /**
     * Every counter in the Rust pipeline.
     *
     * <p>`voice_stats` already answers `running: false` with zeroed counters when no engine exists, so
     * the port's non-nullable contract needs nothing added here - which is the reason the port chose it
     * over `VoiceEngineService.stats()`'s nullable return.</p>
     */
    async stats(): Promise<VoiceStats> {
        const {invoke} = await this.tauri();
        return await invoke<VoiceStats>('voice_stats');
    }

    private tauri(): Promise<typeof import('@tauri-apps/api/core')> {
        this.core ??= import('@tauri-apps/api/core');
        return this.core;
    }

    /**
     * The settings `voice_start` opens the devices with.
     *
     * <p>The fallback is never taken in this app - `VoiceEngineService` pushes real settings before
     * every start - and exists so a caller that reached the port directly gets a working engine on the
     * default devices rather than a rejected join. Loud about it, because starting on invented settings
     * means the user's chosen microphone was ignored.</p>
     */
    private settingsPayload(): VoiceProcessing {
        if (this.processing) return this.processing;
        console.warn('[voice] starting on default processing settings - none were pushed first');
        return {
            deviceId: null,
            outputDeviceId: null,
            noiseSuppression: 'standard',
            echoCancellation: true,
            autoGainControl: true,
            inputMode: 'voice',
            sensitivity: 0.6,
            inputVolume: 1,
            outputVolume: 1,
            bitrateBps: null,
        };
    }
}
