import {inject, Injectable} from '@angular/core';
import {environment} from '../../environments/environment';
import {SpatialModel, VoiceEngineService} from './voice-engine.service';

/**
 * Turns Isle's world telemetry into listener-relative positions for the Rust mixer: Unreal
 * centimetres in, mixer metres relative to where the listener is looking out.
 *
 * The extrapolation timer must stay a `setInterval`, not `requestAnimationFrame`: this window is
 * backgrounded while the game is focused, which pauses rAF entirely but only throttles timers.
 */

/** Dev-only tuning knobs (see `environment.isleVoice`), with safe defaults. */
const TUNING_DEFAULTS = {
    spatialIntensity: 0.6,
    panningModel: 'HRTF' as const,
    refDistance: 1500,
    maxDistance: 8000,
    rolloffFactor: 1.6,
};
const envTuning = (environment as {isleVoice?: Partial<typeof TUNING_DEFAULTS>}).isleVoice ?? {};
const TUNING = {...TUNING_DEFAULTS, ...envTuning};

/** Backend `VoiceGridConfig.CellSize` (cm) = 80 m: audible range must never exceed one cell, or two players a metre apart across a cell border hear nothing. */
const BACKEND_CELL_SIZE = 8000;
/** Audible range in Unreal units (cm) = 80 m; audio is inaudible beyond this. */
const CELL_UNITS = Math.min(TUNING.maxDistance, BACKEND_CELL_SIZE);
if (TUNING.maxDistance > BACKEND_CELL_SIZE) {
    console.warn(
        `[isle-voice] maxDistance ${TUNING.maxDistance} exceeds backend CellSize ` +
            `${BACKEND_CELL_SIZE}; clamping to avoid the cell-border cliff.`,
    );
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

    /** Proximity volume, 0-1. Per-peer gain, not the engine master, which is the global output slider. */
    setMasterVolume(volume: number): void {
        this.masterVolume = Math.max(0, Math.min(1, volume));
        for (const userId of this.peers.keys()) void this.engine.setUserVolume(userId, this.masterVolume);
    }

    /** The user's spatial-audio toggle: off is panning intensity zero, not unplaced sources, because distance must still attenuate. */
    setSpatialEnabled(enabled: boolean): void {
        if (enabled === this.spatialEnabled) return;
        this.spatialEnabled = enabled;
        void this.pushModel();
    }

    /** No-op: proximity voice has no output device of its own, it leaves through the Rust engine's. */
    async setOutputDevice(_deviceName: string): Promise<void> {
        // Deliberately nothing.
    }

    // ── Listener (self) ──────────────────────────────────────────────────────────

    /** Latest self telemetry. Velocity defaults to 0 (older servers) → hold position. */
    updateSelf(x: number, y: number, z: number, yaw: number, vx = 0, vy = 0, vz = 0): void {
        this.self = {x, y, z, vx, vy, vz, recvAt: performance.now()};
        this.selfYaw = yaw;
    }

    // ── Peers ─────────────────────────────────────────────────────────────────

    /** Start placing a peer; their audio is already in the Rust mixer, only a position attaches here. */
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
    updatePeer(userId: string, x: number, y: number, z: number, vx = 0, vy = 0, vz = 0): void {
        this.peers.set(userId, {x, y, z, vx, vy, vz, recvAt: performance.now()});
    }

    removePeer(userId: string): void {
        if (!this.peers.delete(userId)) return;
        // Un-place explicitly: a peer can stop being placed while still being heard, and a stale
        // position would leave them stuck at the last spot they were seen.
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

    /** Push falloff and panning tuning to the mixer, in metres; the audible radius is clamped to {@link CELL_UNITS}. */
    private async pushModel(): Promise<void> {
        const model: SpatialModel = {
            refDistance: TUNING.refDistance / UNITS_PER_METRE,
            rolloff: TUNING.rolloffFactor,
            maxDistance: CELL_UNITS / UNITS_PER_METRE,
            // Zero centres every placed source while leaving distance attenuation alone.
            intensity: this.spatialEnabled ? clamp01(TUNING.spatialIntensity) : 0,
        };
        await this.engine
            .setSpatialModel(model)
            .catch(e => console.error('[isle-voice] the mixer rejected the spatial model', e));
    }

    /** Extrapolate a sample to "now" (pos + vel·dt), coasting at most MAX_EXTRAP_MS. */
    private extrapolate(s: MotionState): {x: number; y: number; z: number} {
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

        // Both endpoints coast off their own velocity, so a moving listener still pans correctly.
        const me = this.extrapolate(this.self);
        const them = this.extrapolate(state);
        void this.engine.setPosition(
            userId,
            listenerRelative(them.x - me.x, them.y - me.y, them.z - me.z, this.selfYaw),
        );
    }
}

function clamp01(v: number): number {
    return Math.max(0, Math.min(1, v));
}

/**
 * A world-space delta in Unreal units, as metres in the listener's own frame.
 *
 * Unreal is left-handed (+X forward, +Y right, +Z up), the mixer right-handed (+x right, +y up,
 * +z forward), and yaw grows clockwise from above, so this is a rotation by -yaw; getting the
 * handedness wrong silently mirrors the world.
 */
export function listenerRelative(
    dFwd: number,
    dRight: number,
    dUp: number,
    yawDegrees: number,
): {x: number; y: number; z: number} {
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
