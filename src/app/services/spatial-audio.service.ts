import {inject, Injectable} from '@angular/core';
import {environment} from '../../environments/environment';
import {SpatialModel, VoiceEngineService} from './voice-engine.service';

/**
 * Turns Isle's world telemetry into listener-relative positions for the Rust mixer.
 *
 * This used to be a Web Audio graph - a `PannerNode` per peer, a listener, a master gain and a
 * `setSinkId` output. None of that can see the audio any more: proximity voice is decoded and mixed
 * in Rust alongside every other call, so panning happens there and this is left holding the one job
 * the webview is still the right place for - the coordinate maths.
 *
 * Positions arrive in Unreal world coordinates (centimetres, left-handed, Z-up: +X forward, +Y
 * right, +Z up) plus the local player's yaw. The mixer wants metres, listener-relative, +x right,
 * +y up, +z forward - so the delta is rotated into the listener's frame here. Rust has no notion of
 * where anybody is standing; it only knows where they are *from you*.
 *
 * Motion: telemetry arrives at ~1 Hz with a velocity vector. Each sample is stamped with a local
 * {@link performance.now} receipt time and extrapolated (`pos + vel·dt`, clamped to
 * {@link MAX_EXTRAP_MS}) on a fixed timer, so peers glide instead of teleporting once a second. The
 * timer is a `setInterval`, not `requestAnimationFrame`: while the game is focused this window is
 * backgrounded, which pauses rAF entirely but only throttles timers - and since extrapolation is
 * time-based, a slower tick means coarser updates, never wrong positions.
 */

/** Dev-only tuning knobs (see `environment.isleVoice`), with safe defaults. */
const TUNING_DEFAULTS = {
    spatialIntensity: 0.6,
    panningModel: 'HRTF' as const,
    refDistance: 1500,
    maxDistance: 8000,
    rolloffFactor: 1.6,
};
const envTuning = (environment as { isleVoice?: Partial<typeof TUNING_DEFAULTS> }).isleVoice ?? {};
const TUNING = {...TUNING_DEFAULTS, ...envTuning};

/**
 * Backend `VoiceGridConfig.CellSize` in Unreal units (cm) = 80 m. Audibility is a coarse 3x3 cell
 * subscription plus client distance attenuation as the real edge, which stays cliff-free only while
 * our range never exceeds one cell -otherwise two players a metre apart across a cell border hear
 * nothing. Bump only when the backend does.
 */
const BACKEND_CELL_SIZE = 8000;
/** Audible range in Unreal units (cm) = 80 m -audio is inaudible beyond this. */
const CELL_UNITS = Math.min(TUNING.maxDistance, BACKEND_CELL_SIZE);
if (TUNING.maxDistance > BACKEND_CELL_SIZE) {
    console.warn(`[isle-voice] maxDistance ${TUNING.maxDistance} exceeds backend CellSize ` +
        `${BACKEND_CELL_SIZE}; clamping to avoid the cell-border cliff.`);
}

/** Unreal units per metre. Telemetry is in centimetres; the mixer works in metres. */
const UNITS_PER_METRE = 100;

/** How far past the last sample we coast before holding position (ms). */
const MAX_EXTRAP_MS = 1500;
/** Extrapolation tick period (ms). ~20 Hz when foregrounded; throttled when hidden. */
const TICK_MS = 50;

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

@Injectable({providedIn: 'root'})
export class SpatialAudioService {
    private readonly engine = inject(VoiceEngineService);

    private spatialEnabled = true;
    /** Proximity volume, 0-1. Applied per peer, because the engine's master is the output slider. */
    private masterVolume = 1;

    private self: MotionState | null = null;
    private selfYaw = 0;
    /** Drives extrapolation; null when no peers are being tracked. */
    private tickHandle: ReturnType<typeof setInterval> | null = null;

    private readonly peers = new Map<string, MotionState | null>();

    // ── Configuration ──────────────────────────────────────────────────────────

    /**
     * Proximity volume, 0-1.
     *
     * Applied as a per-source gain on each proximity peer rather than through the engine's master,
     * which is the global output slider and would drag a guild call down with it.
     *
     * @param volume 0–1
     */
    setMasterVolume(volume: number): void {
        this.masterVolume = Math.max(0, Math.min(1, volume));
        for (const userId of this.peers.keys()) void this.engine.setUserVolume(userId, this.masterVolume);
    }

    /**
     * The user's spatial-audio toggle.
     *
     * Off does not mean "stop placing people" - distance still has to attenuate, or everyone in
     * range would be equally loud. It means panning intensity zero, which centres every placed
     * source while leaving the falloff intact.
     */
    setSpatialEnabled(enabled: boolean): void {
        if (enabled === this.spatialEnabled) return;
        this.spatialEnabled = enabled;
        void this.pushModel();
    }

    /**
     * Retained so the settings page and {@link IsleProximityService} keep one call shape for all
     * audio output, but proximity voice no longer has an output device of its own: it is mixed into
     * the same stereo frame as every other call and leaves through the device the Rust engine
     * opened. The speaker setting reaches it through the ordinary audio settings instead.
     */
    async setOutputDevice(_deviceName: string): Promise<void> {
        // Deliberately nothing.
    }

    // ── Listener (self) ──────────────────────────────────────────────────────────

    /** Latest self telemetry. Velocity defaults to 0 (older servers) → hold position. */
    updateSelf(x: number, y: number, z: number, yaw: number,
               vx = 0, vy = 0, vz = 0): void {
        this.self = {x, y, z, vx, vy, vz, recvAt: performance.now()};
        this.selfYaw = yaw;
    }

    // ── Peers ─────────────────────────────────────────────────────────────────

    /**
     * Start placing a peer.
     *
     * No longer takes a `MediaStream`: their audio is already in the Rust mixer, pulled onto the
     * proximity publication by {@link IsleVoiceRtcService}. All that is left to attach is a
     * position.
     */
    addPeer(userId: string): void {
        // Keep any position that arrived before their track did.
        if (!this.peers.has(userId)) this.peers.set(userId, null);
        void this.engine.setUserVolume(userId, this.masterVolume);
        void this.pushModel();
        this.startRenderLoop();
        this.reposition(userId);
    }

    /**
     * Update a peer's world telemetry (yaw currently unused for peers). Stored with its receipt
     * time; the tick loop extrapolates and repositions.
     */
    updatePeer(userId: string, x: number, y: number, z: number,
               vx = 0, vy = 0, vz = 0): void {
        this.peers.set(userId, {x, y, z, vx, vy, vz, recvAt: performance.now()});
    }

    removePeer(userId: string): void {
        if (!this.peers.delete(userId)) return;
        // Un-place them explicitly. The engine drops the position when their track is unsubscribed,
        // but a peer can stop being *placed* while still being heard - and a stale position would
        // leave them stuck at the last spot they were seen.
        void this.engine.setPosition(userId, null);
        if (!this.peers.size) this.stopRenderLoop();
    }

    hasPeer(userId: string): boolean {
        return this.peers.has(userId);
    }

    /** Tear everything down (leave voice / hub loss). */
    reset(): void {
        this.stopRenderLoop();
        for (const userId of [...this.peers.keys()]) void this.engine.setPosition(userId, null);
        this.peers.clear();
        this.self = null;
        this.selfYaw = 0;
    }

    // ── Internals ────────────────────────────────────────────────────────────────

    /**
     * Push the falloff and panning tuning to the mixer.
     *
     * Converted from the Unreal centimetres the tuning is written in to the metres the mixer works
     * in. The audible radius is {@link CELL_UNITS} rather than the raw configured value, because it
     * has to stay inside the backend's subscription cell.
     */
    private async pushModel(): Promise<void> {
        const model: SpatialModel = {
            refDistance: TUNING.refDistance / UNITS_PER_METRE,
            rolloff: TUNING.rolloffFactor,
            maxDistance: CELL_UNITS / UNITS_PER_METRE,
            // Zero centres every placed source while leaving distance attenuation alone, which is
            // what the user's spatial toggle being off should mean.
            intensity: this.spatialEnabled ? clamp01(TUNING.spatialIntensity) : 0,
        };
        await this.engine.setSpatialModel(model).catch(e =>
            console.error('[isle-voice] the mixer rejected the spatial model', e));
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

    private reposition(userId: string): void {
        const state = this.peers.get(userId);
        if (!state || !this.self) return;

        // Extrapolate both endpoints to "now", then take the relative vector in Unreal space (peer
        // minus listener). Both coast off their own velocity, so a moving listener with static peers
        // still pans correctly.
        const me = this.extrapolate(this.self);
        const them = this.extrapolate(state);
        void this.engine.setPosition(userId, listenerRelative(
            them.x - me.x, them.y - me.y, them.z - me.z, this.selfYaw));
    }
}

function clamp01(v: number): number {
    return Math.max(0, Math.min(1, v));
}

/**
 * A world-space delta in Unreal units, as metres in the listener's own frame.
 *
 * The rotation is the part that used to be the `AudioContext.listener` orientation. Rust knows
 * nothing about facing - it is handed positions already relative to where the listener is looking -
 * so turning on the spot has to move every peer, and that happens here.
 *
 * Unreal is left-handed with +X forward, +Y right, +Z up; the mixer is right-handed with +x right,
 * +y up, +z forward. Yaw grows clockwise seen from above, so rotating the delta *into* the
 * listener's frame is a rotation by −yaw.
 *
 * Exported for tests: getting the handedness wrong produces a mirrored world that looks entirely
 * correct in code and is immediately obvious in game.
 */
export function listenerRelative(
    dFwd: number, dRight: number, dUp: number, yawDegrees: number,
): { x: number; y: number; z: number } {
    const yaw = (yawDegrees * Math.PI) / 180;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);

    const forward = dFwd * cos + dRight * sin;
    const right = -dFwd * sin + dRight * cos;

    return {
        x: right / UNITS_PER_METRE,
        y: dUp / UNITS_PER_METRE,
        z: forward / UNITS_PER_METRE,
    };
}
