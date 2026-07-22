import {Injectable} from '@angular/core';
import {environment} from '../../environments/environment';

/**
 * Web Audio spatializer for Isle proximity voice.
 *
 * Each remote peer's `MediaStream` is routed through its own graph; the single
 * `AudioContext.listener` is the local player. Positions arrive in Unreal world
 * coordinates (centimetres, left-handed, Z-up: +X forward, +Y right, +Z up) and
 * are converted to the Web Audio frame (right-handed, Y-up, −Z forward).
 *
 * Per-peer graph (distance handled once, then a wet/dry directional blend):
 *
 *   source → distanceGain ─┬→ panner(HRTF) → wetGain ─┐
 *                          └───────────────→ dryGain ─┴→ masterGain → sink
 *
 *  - `distanceGain` applies inverse-distance attenuation in BOTH modes, so the
 *    panner is left to do direction only (`rolloffFactor: 0`).
 *  - `wetGain`/`dryGain` cross-fade the panned copy against a centered mono copy.
 *    `spatialIntensity` (dev config) sets the wet share: 1 = full HRTF (a 90°
 *    source is almost ear-exclusive), lower values keep direction findable while
 *    still bleeding into both ears so you can't aim a rifle by it. The user's
 *    spatial toggle being off forces intensity 0 (pure mono distance-only).
 *
 * Output device: the whole mix goes through `AudioContext.setSinkId`, so the
 * user's speaker selection is honoured and can be switched live (no teardown).
 *
 * Motion: position telemetry arrives at ~1 Hz with a velocity vector. We store
 * each sample stamped with a local {@link performance.now} receipt time and
 * extrapolate (`pos + vel·dt`, clamped to {@link MAX_EXTRAP_MS}) on a fixed
 * timer, so peers glide instead of teleporting once a second. The timer is a
 * `setInterval`, not `requestAnimationFrame`: while the game is focused this
 * (Echo) window is backgrounded/occluded, which pauses rAF entirely but only
 * throttles timers -and since extrapolation is time-based, a slower tick just
 * means coarser updates, never wrong positions.
 *
 * WebView2 quirk: an unrendered MediaStreamAudioSourceNode may not pump, so every
 * peer stream is also attached to a muted <audio> element to keep it flowing.
 */

/** Dev-only tuning knobs (see `environment.isleVoice`), with safe defaults. */
const TUNING_DEFAULTS = {
    spatialIntensity: 0.6,
    panningModel: 'HRTF' as PanningModelType,
    refDistance: 300,
    maxDistance: 3000,
    rolloffFactor: 1,
};
const envTuning = (environment as { isleVoice?: Partial<typeof TUNING_DEFAULTS> }).isleVoice ?? {};
const TUNING = {
    ...TUNING_DEFAULTS,
    ...envTuning,
    // env delivers panningModel as a plain string; keep it as the literal union.
    panningModel: (envTuning.panningModel ?? TUNING_DEFAULTS.panningModel) as PanningModelType,
};

/** Voice cell size in Unreal units (cm) = 30 m -audio is inaudible beyond this. */
const CELL_UNITS = TUNING.maxDistance;
/** Full volume within this distance (cm). */
const REF_DISTANCE = TUNING.refDistance;
/** Distance attenuation steepness. */
const ROLLOFF = TUNING.rolloffFactor;

/** How far past the last sample we coast before holding position (ms). */
const MAX_EXTRAP_MS = 1500;
/** Extrapolation tick period (ms). ~20 Hz when foregrounded; throttled when hidden. */
const TICK_MS = 50;
/** Smoothing time-constant for panner/gain param glides (s). */
const SMOOTH_TAU = 0.05;

/** AudioContext augmented with the output-device selection API (Chromium 110+). */
type AudioContextWithSink = AudioContext & { setSinkId?: (sinkId: string) => Promise<void> };

/** A position sample plus the velocity and local receipt time used to extrapolate it. */
interface MotionState {
    x: number;
    y: number;
    z: number;
    /** Velocity in UE units/second (same axes as position). */
    vx: number;
    vy: number;
    vz: number;
    /** `performance.now()` when this sample was received (NOT the server timestamp). */
    recvAt: number;
}

interface PeerNode {
    stream: MediaStream;
    source: MediaStreamAudioSourceNode;
    /** Distance attenuation, applied before the wet/dry split (both modes). */
    distanceGain: GainNode;
    /** Directional (HRTF) copy. */
    panner: PannerNode;
    /** Level of the panned copy in the mix. */
    wetGain: GainNode;
    /** Level of the centered (mono) copy in the mix. */
    dryGain: GainNode;
    /** Muted sink element that forces WebView2 to pump the stream. */
    audioEl: HTMLAudioElement;
    state: MotionState | null;
}

@Injectable({providedIn: 'root'})
export class SpatialAudioService {
    private ctx: AudioContext | null = null;
    private masterGain: GainNode | null = null;
    private spatialEnabled = true;
    private masterVolume = 1;
    /** Directional share of the mix when spatial is enabled (0–1). */
    private spatialIntensity = clamp01(TUNING.spatialIntensity);
    /** Selected output device; '' means the system default sink. */
    private sinkId = '';

    private self: MotionState | null = null;
    private selfYaw = 0;
    /** Drives extrapolation; null when no context/graph is live. */
    private tickHandle: ReturnType<typeof setInterval> | null = null;

    private readonly peers = new Map<string, PeerNode>();
    /** Positions that arrived before the peer's audio track (ontrack) did. */
    private readonly pendingPos = new Map<string, MotionState>();

    // ── Configuration ──────────────────────────────────────────────────────────

    /** @param volume 0–1 */
    setMasterVolume(volume: number): void {
        this.masterVolume = Math.max(0, Math.min(1, volume));
        if (this.masterGain && this.ctx) {
            this.masterGain.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.02);
        }
    }

    setSpatialEnabled(enabled: boolean): void {
        if (enabled === this.spatialEnabled) return;
        this.spatialEnabled = enabled;
        for (const peer of this.peers.values()) this.applyBlend(peer);
    }

    /**
     * Select the output device for the proximity mix and apply it live.
     *
     * Uses `AudioContext.setSinkId`, so switching devices takes effect instantly
     * without tearing down the session. `'default'`/empty map to the system sink.
     */
    async setOutputDevice(deviceId: string): Promise<void> {
        const next = (!deviceId || deviceId === 'default') ? '' : deviceId;
        if (next === this.sinkId && this.ctx) {
            // Already applied; nothing to do (unless the context isn't up yet).
            await this.applySink();
            return;
        }
        this.sinkId = next;
        await this.applySink();
    }

    // ── Listener (self) ──────────────────────────────────────────────────────────

    /** Latest self telemetry. Velocity defaults to 0 (older servers) → hold position. */
    updateSelf(x: number, y: number, z: number, yaw: number,
               vx = 0, vy = 0, vz = 0): void {
        this.self = {x, y, z, vx, vy, vz, recvAt: performance.now()};
        this.selfYaw = yaw;
        // Yaw isn't extrapolated, so apply it immediately; the tick loop handles
        // per-peer repositioning off the extrapolated self/peer positions.
        this.applyListenerOrientation();
    }

    // ── Peers ─────────────────────────────────────────────────────────────────

    /** Attach a peer's audio stream and start spatializing it. */
    attachPeer(userId: string, stream: MediaStream): void {
        const ctx = this.ensureContext();
        this.removePeer(userId); // replace any stale entry for this user

        const source = ctx.createMediaStreamSource(stream);

        const distanceGain = ctx.createGain();
        distanceGain.gain.value = 1;

        const panner = new PannerNode(ctx, {
            panningModel: TUNING.panningModel,
            distanceModel: 'inverse',
            refDistance: REF_DISTANCE,
            maxDistance: CELL_UNITS,
            // Distance is done manually on distanceGain; the panner is direction-only.
            rolloffFactor: 0,
        });

        const wetGain = ctx.createGain();
        const dryGain = ctx.createGain();

        // Muted sink so WebView2 keeps the stream flowing into Web Audio.
        const audioEl = new Audio();
        audioEl.srcObject = stream;
        audioEl.muted = true;
        audioEl.autoplay = true;
        void audioEl.play().catch(() => void 0);

        const peer: PeerNode = {
            stream,
            source,
            distanceGain,
            panner,
            wetGain,
            dryGain,
            audioEl,
            state: this.pendingPos.get(userId) ?? null,
        };
        this.pendingPos.delete(userId);
        this.peers.set(userId, peer);

        // source → distanceGain ─┬→ panner → wetGain ─┐
        //                        └──────────→ dryGain ─┴→ master
        source.connect(distanceGain);
        distanceGain.connect(panner).connect(wetGain).connect(this.masterGain!);
        distanceGain.connect(dryGain).connect(this.masterGain!);

        this.applyBlend(peer);
        this.reposition(userId);
        void ctx.resume().catch(() => void 0);
    }

    /**
     * Update a peer's world telemetry (yaw currently unused for peers). Stored
     * with its receipt time; the tick loop extrapolates and repositions.
     */
    updatePeer(userId: string, x: number, y: number, z: number,
               vx = 0, vy = 0, vz = 0): void {
        const state: MotionState = {x, y, z, vx, vy, vz, recvAt: performance.now()};
        const peer = this.peers.get(userId);
        if (!peer) {
            this.pendingPos.set(userId, state);
            return;
        }
        peer.state = state;
    }

    removePeer(userId: string): void {
        const peer = this.peers.get(userId);
        if (!peer) return;
        try {
            peer.source.disconnect();
            peer.distanceGain.disconnect();
            peer.panner.disconnect();
            peer.wetGain.disconnect();
            peer.dryGain.disconnect();
        } catch { /* nodes may already be detached */ }
        peer.audioEl.pause();
        peer.audioEl.srcObject = null;
        this.peers.delete(userId);
        this.pendingPos.delete(userId);
    }

    hasPeer(userId: string): boolean {
        return this.peers.has(userId);
    }

    /** Tear everything down (leave voice / hub loss). */
    reset(): void {
        this.stopRenderLoop();
        for (const userId of [...this.peers.keys()]) this.removePeer(userId);
        this.pendingPos.clear();
        this.self = null;
        this.selfYaw = 0;
        this.masterGain?.disconnect();
        this.masterGain = null;
        void this.ctx?.close().catch(() => void 0);
        this.ctx = null;
    }

    // ── Internals ────────────────────────────────────────────────────────────────

    private ensureContext(): AudioContext {
        if (this.ctx) return this.ctx;
        const ctx = new AudioContext();
        const master = ctx.createGain();
        master.gain.value = this.masterVolume;
        master.connect(ctx.destination);
        this.setListenerPosition(ctx, 0, 0, 0);
        this.ctx = ctx;
        this.masterGain = master;
        this.applyListenerOrientation();
        // Honour the selected output device as soon as the graph exists.
        void this.applySink();
        this.startRenderLoop();
        return ctx;
    }

    /** Extrapolate a sample to "now" (pos + vel·dt), coasting at most MAX_EXTRAP_MS. */
    private extrapolate(s: MotionState): { x: number; y: number; z: number } {
        const dt = Math.min(performance.now() - s.recvAt, MAX_EXTRAP_MS) / 1000;
        return {x: s.x + s.vx * dt, y: s.y + s.vy * dt, z: s.z + s.vz * dt};
    }

    /** Fixed-rate loop that re-derives every peer's relative position from extrapolation. */
    private startRenderLoop(): void {
        if (this.tickHandle !== null) return;
        this.tickHandle = setInterval(() => {
            if (!this.self) return;
            for (const userId of this.peers.keys()) this.reposition(userId);
        }, TICK_MS);
    }

    private stopRenderLoop(): void {
        if (this.tickHandle !== null) {
            clearInterval(this.tickHandle);
            this.tickHandle = null;
        }
    }

    /** Cross-fade a peer's panned (wet) vs centered (dry) copies. */
    private applyBlend(peer: PeerNode): void {
        if (!this.ctx) return;
        const t = this.ctx.currentTime;
        const wet = this.spatialEnabled ? this.spatialIntensity : 0;
        peer.wetGain.gain.setTargetAtTime(wet, t, 0.02);
        peer.dryGain.gain.setTargetAtTime(1 - wet, t, 0.02);
    }

    /** Push the current sink selection onto the live AudioContext, if supported. */
    private async applySink(): Promise<void> {
        const ctx = this.ctx as AudioContextWithSink | null;
        if (!ctx || typeof ctx.setSinkId !== 'function') return;
        try {
            await ctx.setSinkId(this.sinkId);
        } catch (e) {
            console.error('[isle-voice] setSinkId failed', e);
        }
    }

    private reposition(userId: string): void {
        const peer = this.peers.get(userId);
        if (!peer || !peer.state || !this.self || !this.ctx) return;

        // Extrapolate both endpoints to "now", then take the relative vector in
        // Unreal space (peer minus listener). Both coast off their own velocity,
        // so a moving listener with static peers still pans correctly.
        const me = this.extrapolate(this.self);
        const them = this.extrapolate(peer.state);
        const dFwd = them.x - me.x;
        const dRight = them.y - me.y;
        const dUp = them.z - me.z;

        // Distance attenuation (inverse model, matching the classic PannerNode
        // curve) applied once, before the wet/dry split, so both modes fade alike.
        const dist = Math.hypot(dFwd, dRight, dUp);
        const clamped = Math.min(Math.max(dist, REF_DISTANCE), CELL_UNITS);
        const g = REF_DISTANCE / (REF_DISTANCE + ROLLOFF * (clamped - REF_DISTANCE));
        const t = this.ctx.currentTime;
        peer.distanceGain.gain.setTargetAtTime(g, t, SMOOTH_TAU);

        // Direction: UE(+X fwd, +Y right, +Z up) → WebAudio(x right, y up, z back).
        // Magnitude is irrelevant to HRTF direction (only the angle matters).
        const ax = dRight;
        const ay = dUp;
        const az = -dFwd;
        if (peer.panner.positionX) {
            peer.panner.positionX.setTargetAtTime(ax, t, SMOOTH_TAU);
            peer.panner.positionY.setTargetAtTime(ay, t, SMOOTH_TAU);
            peer.panner.positionZ.setTargetAtTime(az, t, SMOOTH_TAU);
        } else {
            // Deprecated fallback for older WebView engines.
            (peer.panner as unknown as { setPosition(x: number, y: number, z: number): void })
                .setPosition(ax, ay, az);
        }
    }

    private applyListenerOrientation(): void {
        if (!this.ctx) return;
        const listener = this.ctx.listener;
        const yaw = (this.selfYaw * Math.PI) / 180;
        // forward = (-X component maps to −Z fwd, +Y component maps to +X right)
        const fwdX = Math.sin(yaw);
        const fwdZ = -Math.cos(yaw);
        if (listener.forwardX) {
            const t = this.ctx.currentTime;
            listener.forwardX.setTargetAtTime(fwdX, t, 0.02);
            listener.forwardY.setTargetAtTime(0, t, 0.02);
            listener.forwardZ.setTargetAtTime(fwdZ, t, 0.02);
            listener.upX.setTargetAtTime(0, t, 0.02);
            listener.upY.setTargetAtTime(1, t, 0.02);
            listener.upZ.setTargetAtTime(0, t, 0.02);
        } else {
            (listener as unknown as {
                setOrientation(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void
            }).setOrientation(fwdX, 0, fwdZ, 0, 1, 0);
        }
    }

    private setListenerPosition(ctx: AudioContext, x: number, y: number, z: number): void {
        const listener = ctx.listener;
        if (listener.positionX) {
            listener.positionX.value = x;
            listener.positionY.value = y;
            listener.positionZ.value = z;
        } else {
            (listener as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(x, y, z);
        }
    }
}

function clamp01(v: number): number {
    return Math.max(0, Math.min(1, v));
}
