import {inject, Injectable, signal} from '@angular/core';
import {OAuthService} from 'angular-oauth2-oidc';
import {ApiConfigService} from './api-config.service';
import {DeviceIdentityService} from './device-identity.service';
import {SpatialAudioService} from './spatial-audio.service';
import {VoiceEngineService, VoiceSession} from './voice-engine.service';

/**
 * Isle proximity voice, as a publication on the shared Rust audio engine.
 *
 * This used to own everything: its own `getUserMedia`, its own `RTCPeerConnection`, its own
 * WebAudio gain stage on the way out and a spatializer on the way in. The reason given for the
 * separate microphone was that push-to-talk here must not key the guild channel's - which is now a
 * property of the engine rather than of a second capture, so proximity voice can share the one
 * microphone, the one echo canceller and the one mixer with whatever else is running.
 *
 * That sharing is the point. Two engines each played through their own output, so neither echo
 * canceller could see the other's audio and proximity voice leaked into the guild microphone with
 * nothing able to remove it.
 *
 * What is left here is the parts Rust does not own: which peers to pull, and when.
 * {@link SpatialAudioService} keeps the coordinate maths and feeds positions to the same mixer.
 */
@Injectable({providedIn: 'root'})
export class IsleVoiceRtcService {
    /**
     * Connection state for the proximity UI.
     *
     * Rust owns the peer connection now, so this is no longer an `RTCPeerConnection.connectionState`
     * being observed - it is whether the publication exists. The type is kept so the status
     * indicators that read it need no change.
     */
    readonly rtcState = signal<RTCPeerConnectionState>('new');
    /** userIds currently pulled and placed. */
    readonly peers = signal<Set<string>>(new Set());

    private engine = inject(VoiceEngineService);
    private spatial = inject(SpatialAudioService);
    private apiConfig = inject(ApiConfigService);
    private oauth = inject(OAuthService);
    private deviceIdentity = inject(DeviceIdentityService);

    /** The proximity publication, once connected. Its own slot, alongside any guild or DM call. */
    private session: VoiceSession | null = null;
    /**
     * Serialises connect against subscribe, so a SubscribeMutual arriving immediately cannot try to
     * pull a peer before there is a publication to pull them onto.
     */
    private ready: Promise<void> = Promise.resolve();

    get isConnected(): boolean {
        return this.session !== null;
    }

    // ── Publish ──────────────────────────────────────────────────────────────

    /** Open the proximity session and start publishing the microphone into it. */
    async connect(): Promise<boolean> {
        let release!: () => void;
        this.ready = new Promise<void>(resolve => (release = resolve));

        try {
            this.session = await this.engine.start(
                {kind: 'isle'},
                this.apiConfig.baseUrl(),
                this.oauth.getAccessToken(),
                await this.deviceIdentity.deviceId(),
            );
            // Proximity voice is push-to-talk in practice, and the engine starts a publication
            // closed in that mode. Nothing is transmitted until setMicEnabled says so.
            this.rtcState.set('connected');
            return true;
        } catch (e) {
            console.error('[isle-voice] proximity publish failed', e);
            this.rtcState.set('failed');
            return false;
        } finally {
            release();
        }
    }

    // ── Subscribe ────────────────────────────────────────────────────────────

    /**
     * Pull a peer's audio into the mix (on isle.SubscribeMutual).
     *
     * There is no offer/answer to serialise here any more - Rust does one round trip per subscribe
     * on its own connection - but connect still has to have finished, or there is no publication to
     * name.
     */
    async subscribeToPeer(userId: string, peerSessionId: string, trackName: string): Promise<void> {
        await this.ready.catch(() => void 0);
        const session = this.session;
        if (!session) return;

        try {
            await this.engine.subscribe(session, userId, peerSessionId, trackName);
        } catch (e) {
            console.error('[isle-voice] failed to pull a peer', {userId, e});
            return;
        }

        // Only once their audio is actually in the mixer. Placing someone who was never pulled
        // would leave a position for a source that does not exist.
        this.spatial.addPeer(userId);
        this.peers.update(s => new Set(s).add(userId));
    }

    // ── Local controls ─────────────────────────────────────────────────────────

    /**
     * Push-to-talk gate for proximity voice specifically.
     *
     * Per publication, so keying here does not also open the guild channel - the same guarantee the
     * separate microphone used to provide, without the second capture.
     */
    setMicEnabled(enabled: boolean): void {
        if (this.session) void this.engine.setPttOpen(this.session, enabled);
    }

    /**
     * Retained for the proximity mic slider, which no longer has anything to act on.
     *
     * There is one capture chain and one encode for every call, and the microphone gain is applied
     * before it - so a proximity-specific gain would mean encoding the same audio twice, which is
     * most of what sharing the engine just bought. The microphone slider in audio settings governs
     * proximity voice too.
     */
    setMicGain(_gain: number): void {
        // Deliberately nothing. See above.
    }

    // ── Teardown ─────────────────────────────────────────────────────────────

    /** Tear down a single peer (on isle.PeerLeft): drop them from the mix and stop placing them. */
    tearDownPeer(userId: string): void {
        this.spatial.removePeer(userId);
        if (this.session) void this.engine.unsubscribe(this.session, userId);
        this.peers.update(s => {
            if (!s.has(userId)) return s;
            const n = new Set(s);
            n.delete(userId);
            return n;
        });
    }

    /** Drop all pulled peers (hub-disconnect safety net / teardown). */
    tearDownAllRemotePeers(): void {
        for (const userId of this.peers()) {
            this.spatial.removePeer(userId);
            if (this.session) void this.engine.unsubscribe(this.session, userId);
        }
        this.peers.set(new Set());
    }

    /**
     * Fully tear down proximity voice.
     *
     * Ends this publication only. Any guild channel or DM call keeps its own, along with the
     * microphone and speakers they share.
     */
    async disconnect(): Promise<void> {
        this.tearDownAllRemotePeers();
        if (this.session) await this.engine.stop(this.session);
        this.session = null;
        this.ready = Promise.resolve();
        this.rtcState.set('new');
        this.spatial.reset();
    }
}
