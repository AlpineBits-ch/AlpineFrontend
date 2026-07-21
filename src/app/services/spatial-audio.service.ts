import {Injectable} from '@angular/core';

/**
 * Web Audio spatializer for Isle proximity voice.
 *
 * Each remote peer's `MediaStream` is routed through its own graph; the single
 * `AudioContext.listener` is the local player. Positions arrive in Unreal world
 * coordinates (centimetres, left-handed, Z-up: +X forward, +Y right, +Z up) and
 * are converted to the Web Audio frame (right-handed, Y-up, −Z forward).
 *
 * Two modes (per {@link setSpatialEnabled}):
 *  - spatial ON  → source → PannerNode(HRTF) → masterGain → destination
 *  - spatial OFF → source → GainNode(distance) → masterGain → destination
 *
 * WebView2 quirk: an unrendered MediaStreamAudioSourceNode may not pump, so every
 * peer stream is also attached to a muted <audio> element to keep it flowing.
 */

/** Voice cell size in Unreal units (cm) = 30 m -audio is inaudible beyond this. */
const CELL_UNITS = 3000;
/** Full volume within this distance (cm) = 3 m. */
const REF_DISTANCE = 300;

interface PeerNode {
    stream: MediaStream;
    source: MediaStreamAudioSourceNode;
    panner: PannerNode;
    /** Distance-only attenuation, used when spatial panning is disabled. */
    gain: GainNode;
    /** Muted sink element that forces WebView2 to pump the stream. */
    audioEl: HTMLAudioElement;
    pos: { x: number; y: number; z: number } | null;
}

@Injectable({providedIn: 'root'})
export class SpatialAudioService {
    private ctx: AudioContext | null = null;
    private masterGain: GainNode | null = null;
    private spatialEnabled = true;
    private masterVolume = 1;

    private self: { x: number; y: number; z: number } | null = null;
    private selfYaw = 0;

    private readonly peers = new Map<string, PeerNode>();
    /** Positions that arrived before the peer's audio track (ontrack) did. */
    private readonly pendingPos = new Map<string, { x: number; y: number; z: number }>();

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
        for (const [userId, peer] of this.peers) {
            this.route(peer);
            this.reposition(userId);
        }
    }

    // ── Listener (self) ──────────────────────────────────────────────────────────

    updateSelf(x: number, y: number, z: number, yaw: number): void {
        this.self = {x, y, z};
        this.selfYaw = yaw;
        this.applyListenerOrientation();
        for (const userId of this.peers.keys()) this.reposition(userId);
    }

    // ── Peers ─────────────────────────────────────────────────────────────────

    /** Attach a peer's audio stream and start spatializing it. */
    attachPeer(userId: string, stream: MediaStream): void {
        const ctx = this.ensureContext();
        this.removePeer(userId); // replace any stale entry for this user

        const source = ctx.createMediaStreamSource(stream);

        const panner = new PannerNode(ctx, {
            panningModel: 'HRTF',
            distanceModel: 'inverse',
            refDistance: REF_DISTANCE,
            maxDistance: CELL_UNITS,
            rolloffFactor: 1,
        });

        const gain = ctx.createGain();
        gain.gain.value = 1;

        // Muted sink so WebView2 keeps the stream flowing into Web Audio.
        const audioEl = new Audio();
        audioEl.srcObject = stream;
        audioEl.muted = true;
        audioEl.autoplay = true;
        void audioEl.play().catch(() => void 0);

        const peer: PeerNode = {
            stream,
            source,
            panner,
            gain,
            audioEl,
            pos: this.pendingPos.get(userId) ?? null,
        };
        this.pendingPos.delete(userId);
        this.peers.set(userId, peer);

        this.route(peer);
        this.reposition(userId);
        void ctx.resume().catch(() => void 0);
    }

    /** Update a peer's world position (yaw currently unused for peers). */
    updatePeer(userId: string, x: number, y: number, z: number): void {
        const peer = this.peers.get(userId);
        if (!peer) {
            this.pendingPos.set(userId, {x, y, z});
            return;
        }
        peer.pos = {x, y, z};
        this.reposition(userId);
    }

    removePeer(userId: string): void {
        const peer = this.peers.get(userId);
        if (!peer) return;
        try {
            peer.source.disconnect();
            peer.panner.disconnect();
            peer.gain.disconnect();
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
        return ctx;
    }

    /** Wire a peer's source through the active path (panner vs distance-gain). */
    private route(peer: PeerNode): void {
        if (!this.masterGain) return;
        try {
            peer.source.disconnect();
            peer.panner.disconnect();
            peer.gain.disconnect();
        } catch { /* not yet connected */ }

        if (this.spatialEnabled) {
            peer.source.connect(peer.panner).connect(this.masterGain);
        } else {
            peer.source.connect(peer.gain).connect(this.masterGain);
        }
    }

    private reposition(userId: string): void {
        const peer = this.peers.get(userId);
        if (!peer || !peer.pos || !this.self || !this.ctx) return;

        // Relative vector in Unreal space (peer minus listener).
        const dFwd = peer.pos.x - this.self.x;
        const dRight = peer.pos.y - this.self.y;
        const dUp = peer.pos.z - this.self.z;

        if (this.spatialEnabled) {
            // UE(+X fwd, +Y right, +Z up) → WebAudio(x right, y up, z back)
            const ax = dRight;
            const ay = dUp;
            const az = -dFwd;
            if (peer.panner.positionX) {
                const t = this.ctx.currentTime;
                peer.panner.positionX.setTargetAtTime(ax, t, 0.02);
                peer.panner.positionY.setTargetAtTime(ay, t, 0.02);
                peer.panner.positionZ.setTargetAtTime(az, t, 0.02);
            } else {
                // Deprecated fallback for older WebView engines.
                (peer.panner as unknown as { setPosition(x: number, y: number, z: number): void })
                    .setPosition(ax, ay, az);
            }
        } else {
            const dist = Math.hypot(dFwd, dRight, dUp);
            const gain = Math.max(0, 1 - dist / CELL_UNITS);
            peer.gain.gain.setTargetAtTime(gain, this.ctx.currentTime, 0.05);
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
