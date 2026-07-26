import {inject, Injectable, signal} from '@angular/core';
import {firstValueFrom} from 'rxjs';
import {environment} from '../../environments/environment';
import {IsleVoiceApiService} from './isle-voice-api.service';
import {AudioSettingsService} from './audio-settings.service';
import {SpatialAudioService} from './spatial-audio.service';

/**
 * WebRTC lifecycle for Isle proximity voice against the Cloudflare Calls SFU.
 *
 * Structurally mirrors {@link VoiceRTCService} (one RTCPeerConnection, publish own
 * mic once, pull each peer on demand, serialise SDP cycles), but:
 *  - it goes through {@link IsleVoiceApiService} (no guild/channel ids);
 *  - it acquires its OWN `getUserMedia` mic track (not the shared Rust pipeline),
 *    so push-to-talk toggling here never affects guild voice's mic;
 *  - the mic is routed through a Web Audio gain stage before being published, so
 *    the proximity mic volume (including >100% boost) is adjustable live;
 *  - incoming audio is routed into {@link SpatialAudioService} instead of a plain
 *    <audio> element.
 */
@Injectable({providedIn: 'root'})
export class IsleVoiceRtcService {
    readonly rtcState = signal<RTCPeerConnectionState>('new');
    /** userIds currently pulled and spatialized. */
    readonly peers = signal<Set<string>>(new Set());

    private api = inject(IsleVoiceApiService);
    private audioSettings = inject(AudioSettingsService);
    private spatial = inject(SpatialAudioService);

    private pc: RTCPeerConnection | null = null;
    private cfSessionId: string | null = null;
    private localAudioTrack: MediaStreamTrack | null = null;
    private cfAudioTrackName: string | null = null;

    // Mic gain stage: raw mic → source → gain → destination → published track.
    private rawMicStream: MediaStream | null = null;
    private micCtx: AudioContext | null = null;
    private micSource: MediaStreamAudioSourceNode | null = null;
    private micGain: GainNode | null = null;
    private micDest: MediaStreamAudioDestinationNode | null = null;
    /** Current outgoing mic gain (1 = unity); retained so it survives reconnects. */
    private micGainValue = 1;

    // Maps a remote transceiver MID → peer userId.
    private readonly midToUser = new Map<string, string>();
    // ontrack events whose MID isn't mapped yet (arrive before tracks/new resolves).
    private readonly pendingTracks: RTCTrackEvent[] = [];
    // Serialises all offer/answer cycles so concurrent subscribes don't race.
    private negotiationChain: Promise<void> = Promise.resolve();

    get isConnected(): boolean {
        return this.pc !== null && this.cfSessionId !== null;
    }

    // ── Publish (§6.1) ───────────────────────────────────────────────────────

    /** Acquire the mic, open a session and publish the local "audio" track. */
    async connect(): Promise<boolean> {
        // Block the queue until the base publish completes, so a SubscribeMutual
        // that arrives immediately can't negotiate before the offer/answer is done.
        let releaseQueue!: () => void;
        this.negotiationChain = new Promise<void>(resolve => (releaseQueue = resolve));
        this.micGainValue = this.audioSettings.settings().proximityMicGain;

        try {
            let localStream: MediaStream;
            try {
                const raw = await navigator.mediaDevices.getUserMedia({
                    audio: await this.audioSettings.buildAudioConstraint(),
                    video: false,
                });
                // Route the raw mic through a gain node so proximity mic volume
                // (incl. Discord-style >100% boost) can be tuned live without
                // renegotiation; the published track is the gain stage's output.
                localStream = this.buildMicPipeline(raw);
            } catch (e) {
                console.error('[isle-voice] mic acquisition failed', e);
                return false;
            }

            this.pc = new RTCPeerConnection({iceServers: environment.iceServers, bundlePolicy: 'max-bundle'});
            this.pc.ontrack = e => this.handleRemoteTrack(e);
            this.pc.onconnectionstatechange = () => {
                if (this.pc) this.rtcState.set(this.pc.connectionState);
            };

            this.localAudioTrack = localStream.getAudioTracks()[0];
            // Start muted -push-to-talk unmutes only while the key is held.
            this.localAudioTrack.enabled = false;

            const sender = this.pc.addTrack(this.localAudioTrack, localStream);

            const {cfSessionId} = await firstValueFrom(this.api.createSession());
            this.cfSessionId = cfSessionId;

            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);

            const mid = this.pc.getTransceivers().find(t => t.sender === sender)?.mid ?? '0';

            const resp = await firstValueFrom(this.api.tracksNew({
                cfSessionId,
                sessionDescription: this.pc.localDescription!,
                tracks: [{location: 'local', mid, trackName: 'audio'}],
            }));

            this.cfAudioTrackName = resp.tracks[0]?.trackName ?? 'audio';
            await this.pc.setRemoteDescription(resp.sessionDescription);
            if (resp.requiresImmediateRenegotiation) await this.renegotiate();

            return true;
        } catch (e) {
            console.error('[isle-voice] publish failed', e);
            return false;
        } finally {
            releaseQueue();
        }
    }

    // ── Subscribe (§6.2) ─────────────────────────────────────────────────────

    /** Pull a peer's remote audio track (on isle.SubscribeMutual). */
    subscribeToPeer(userId: string, peerSessionId: string, trackName: string): Promise<void> {
        return this.enqueueNegotiation(async () => {
            if (!this.pc || !this.cfSessionId) return;

            this.pc.addTransceiver('audio', {direction: 'recvonly'});

            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);

            const resp = await firstValueFrom(this.api.tracksNew({
                cfSessionId: this.cfSessionId,
                sessionDescription: this.pc.localDescription!,
                tracks: [{location: 'remote', sessionId: peerSessionId, trackName}],
            }));

            for (const t of resp.tracks) {
                if (t.mid && !t.error) this.midToUser.set(t.mid, userId);
            }

            await this.pc.setRemoteDescription(resp.sessionDescription);
            if (resp.requiresImmediateRenegotiation) await this.renegotiate();

            this.drainPendingTracks();
        });
    }

    // ── Local controls ─────────────────────────────────────────────────────────

    /** Push-to-talk gate. Enables/disables the local mic track without renegotiation. */
    setMicEnabled(enabled: boolean): void {
        if (this.localAudioTrack) this.localAudioTrack.enabled = enabled;
    }

    /**
     * Set the outgoing mic gain (1 = unity, >1 boosts past source level). Applies
     * live via the gain node -no renegotiation, no track replacement.
     */
    setMicGain(gain: number): void {
        this.micGainValue = Math.max(0, gain);
        if (this.micGain && this.micCtx) {
            this.micGain.gain.setTargetAtTime(this.micGainValue, this.micCtx.currentTime, 0.02);
        }
    }

    // ── Teardown ─────────────────────────────────────────────────────────────

    /** Tear down a single peer (on isle.PeerLeft): stop rendering + drop their mapping. */
    tearDownPeer(userId: string): void {
        this.spatial.removePeer(userId);
        for (const [mid, u] of this.midToUser) {
            if (u === userId) this.midToUser.delete(mid);
        }
        this.peers.update(s => {
            if (!s.has(userId)) return s;
            const n = new Set(s);
            n.delete(userId);
            return n;
        });
    }

    /** Stop rendering all pulled peers (hub-disconnect safety net / teardown). */
    tearDownAllRemotePeers(): void {
        this.midToUser.clear();
        this.pendingTracks.length = 0;
        for (const userId of this.peers()) this.spatial.removePeer(userId);
        this.peers.set(new Set());
    }

    /** Fully tear down: close published track, peer connection, mic and spatial graph. */
    async disconnect(): Promise<void> {
        if (this.cfSessionId && this.cfAudioTrackName) {
            await firstValueFrom(this.api.closeTracks(this.cfSessionId, [this.cfAudioTrackName]))
                .catch(() => void 0);
        }
        this.tearDownAllRemotePeers();
        this.localAudioTrack?.stop();
        this.localAudioTrack = null;
        this.teardownMicPipeline();
        this.pc?.close();
        this.pc = null;
        this.cfSessionId = null;
        this.cfAudioTrackName = null;
        this.negotiationChain = Promise.resolve();
        this.rtcState.set('new');
        this.spatial.reset();
    }

    // ── Internals ────────────────────────────────────────────────────────────

    /**
     * Wrap the raw mic in `source → gain → destination` and return the stream
     * carrying the gain-staged track. If Web Audio is unavailable for any reason,
     * fall back to publishing the raw stream (gain fixed at unity).
     */
    private buildMicPipeline(raw: MediaStream): MediaStream {
        this.rawMicStream = raw;
        try {
            const ctx = new AudioContext();
            const source = ctx.createMediaStreamSource(raw);
            const gain = ctx.createGain();
            gain.gain.value = this.micGainValue;
            const dest = ctx.createMediaStreamDestination();
            source.connect(gain).connect(dest);

            this.micCtx = ctx;
            this.micSource = source;
            this.micGain = gain;
            this.micDest = dest;
            void ctx.resume().catch(() => void 0);
            return dest.stream;
        } catch (e) {
            console.error('[isle-voice] mic gain stage unavailable, publishing raw', e);
            this.teardownMicPipeline(false);
            return raw;
        }
    }

    /** Disconnect the gain graph and stop the raw capture. */
    private teardownMicPipeline(stopRaw = true): void {
        try {
            this.micSource?.disconnect();
            this.micGain?.disconnect();
        } catch { /* already detached */ }
        this.micSource = null;
        this.micGain = null;
        this.micDest = null;
        void this.micCtx?.close().catch(() => void 0);
        this.micCtx = null;
        if (stopRaw) {
            this.rawMicStream?.getTracks().forEach(t => t.stop());
            this.rawMicStream = null;
        }
    }

    private handleRemoteTrack(event: RTCTrackEvent): void {
        const mid = event.transceiver.mid;
        if (!mid) return;
        const userId = this.midToUser.get(mid);
        if (!userId) {
            // Track arrived before its mid was mapped -replay after the next subscribe.
            this.pendingTracks.push(event);
            return;
        }
        this.attach(userId, event);
    }

    private drainPendingTracks(): void {
        if (!this.pendingTracks.length) return;
        const still: RTCTrackEvent[] = [];
        for (const event of this.pendingTracks) {
            const userId = event.transceiver.mid ? this.midToUser.get(event.transceiver.mid) : undefined;
            if (userId) this.attach(userId, event);
            else still.push(event);
        }
        this.pendingTracks.length = 0;
        this.pendingTracks.push(...still);
    }

    private attach(userId: string, event: RTCTrackEvent): void {
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        this.spatial.attachPeer(userId, stream);
        this.peers.update(s => {
            const n = new Set(s);
            n.add(userId);
            return n;
        });
    }

    private enqueueNegotiation(fn: () => Promise<void>): Promise<void> {
        const next = this.negotiationChain.catch(() => void 0).then(fn);
        this.negotiationChain = next.catch(() => void 0);
        return next;
    }

    private async renegotiate(): Promise<void> {
        if (!this.pc || !this.cfSessionId) return;
        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);
        const resp = await firstValueFrom(this.api.renegotiate(this.cfSessionId, offer));
        await this.pc.setRemoteDescription(resp.sessionDescription);
    }
}
