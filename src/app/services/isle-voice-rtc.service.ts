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

/**
 * Backoff between attempts to pull one proximity peer, in milliseconds.
 *
 * The same schedule as the guild path's `SUBSCRIBE_RETRY_DELAYS_MS`, and deliberately a separate
 * constant rather than an import: the two cover different windows, and tying them together would
 * make a future change to one silently a change to the other. Isle's relay already retries a
 * subscribe server-side (`VoiceCloudflareEndpoints.TracksNew` routes remote-only pulls through
 * `SubscribeTracksAsync`), so what reaches us here has had its publish race absorbed and these
 * attempts only need to cover a cold connect on a slow link.
 *
 * Exponential and starting at a second, per incident VNT-GE21R3P7: the failure there was the same
 * subscribe reattempted every 5-6 seconds with no backoff, which turned one publisher's problem into
 * a burst against the signalling relay. A tight retry loop against the relay would be its own bug,
 * and four attempts over seven seconds is the most that can be spent before the peer has walked out
 * of earshot anyway - at which point the relay refuses the pull outright, because every remote
 * subscribe is checked against the live audibility graph.
 *
 * Exported so the schedule is asserted rather than described.
 */
export const ISLE_SUBSCRIBE_RETRY_DELAYS_MS = [1000, 2000, 4000] as const;

/**
 * One standing server order to hear a peer, and what became of it.
 *
 * `isle.SubscribeMutual` is the *only* thing that ever says where a peer's audio lives, it is pushed
 * over SignalR without acknowledgement, and the server will not repeat it while the pair stays
 * audible - `VoiceSubscriptionReconcileService` records a pair as pushed whatever the client then
 * made of it. So the set of directives received and not yet retracted by `isle.PeerLeft` *is* the
 * authoritative set of peers who should be audible, and the client keeping no record of it was the
 * whole bug: each order was turned into a fire-and-forget attempt and then forgotten.
 */
interface PeerDirective {
    /**
     * The peer's SFU session id.
     *
     * The part of a directive that changes: a peer who drops their socket is *not* evicted from the
     * grid server-side, so they come back with a fresh session and the same `trackName` ("audio").
     * Dedupe therefore has to key on this, not on the peer - see {@link IsleVoiceRtcService.subscribeQueued}.
     */
    peerSessionId: string;
    trackName: string;
    /** Attempts made against this identity. Per-peer on purpose; an aggregate hides which peer. */
    attempts: number;
    /** Why the last attempt failed, if one did. */
    lastError?: string;
}

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

    /**
     * Every peer the server has ordered us to hear, whether or not we managed to.
     *
     * The authoritative set - see {@link PeerDirective}. Reconciled against {@link peers}, which is
     * what we actually pulled.
     */
    private readonly directives = new Map<string, PeerDirective>();
    /**
     * userId → the peer session we are currently pulling them from, recorded on success only.
     *
     * Recording a *failed* subscribe would make the retry skip the very order that could have carried
     * a working session id. Keyed by session rather than being a bare "have we seen this peer" set,
     * because that cannot tell a repeated order (skip) from a corrected one (resubscribe).
     */
    private readonly subscribedSessions = new Map<string, string>();
    /**
     * userId → a token identifying the newest attempt for them.
     *
     * Bumped by `isle.PeerLeft` and by every teardown, so an attempt still sleeping between retries
     * can tell it has been superseded and stop rather than resurrecting a peer who has walked away.
     */
    private readonly subscribeTokens = new Map<string, number>();
    /**
     * userId → the tail of the chain of engine operations for that peer.
     *
     * Load-bearing rather than tidy, for the interleaving documented at length on `audioOps` in
     * `voice-rtc.service.ts`: the same peer can be ordered twice concurrently (a live
     * `SubscribeMutual` and the backfill in {@link connect}), and unserialised the second call reaches
     * an engine that answers `Ok` for a source it already holds *without pulling anything*, while the
     * first then rolls its own pull back - leaving a recorded subscription with no route, which every
     * later order skips as a duplicate.
     */
    private readonly peerOps = new Map<string, Promise<unknown>>();
    /** Orders that arrived with no publication to pull them onto. Diagnostics only. */
    private deferredOrders = 0;

    get isConnected(): boolean {
        return this.session !== null;
    }

    // ── Publish ──────────────────────────────────────────────────────────────

    /** Open the proximity session and start publishing the microphone into it. */
    async connect(): Promise<boolean> {
        let release!: () => void;
        this.ready = new Promise<void>(resolve => (release = resolve));
        // Deliberately *not* clearing the held orders here. They are cleared when a publication goes
        // away instead ({@link tearDownAllRemotePeers}), because the orders standing at this point are
        // exactly the ones that arrived in a republish's gap between the teardown and this connect -
        // wiping them here would discard the thing the backfill below exists to recover. A held order
        // naming a peer session that has since died costs three bounded, logged attempts; a discarded
        // one costs a peer for the rest of the session.

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
        } catch (e) {
            console.error('[isle-voice] proximity publish failed', e);
            this.rtcState.set('failed');
            return false;
        } finally {
            release();
        }

        // The backfill, and the reason it is event-driven rather than a timer - see {@link reconcile}.
        // Publishing our microphone is what makes the relay re-drive every audible peer, so this is
        // the one moment at which the order set can be complete and the pulled set can be empty.
        // Deliberately not awaited: it retries for several seconds, and joining must not wait on it.
        void this.reconcile();
        return true;
    }

    // ── Subscribe ────────────────────────────────────────────────────────────

    /**
     * Pull a peer's audio into the mix (on isle.SubscribeMutual).
     *
     * There is no offer/answer to serialise here any more - Rust does one round trip per subscribe
     * on its own connection - but connect still has to have finished, or there is no publication to
     * name.
     *
     * <p>The order is recorded <b>before</b> anything can drop it. That ordering is the fix for the
     * worst of the failure modes here: the relay pushes a SubscribeMutual for every already-audible
     * peer from inside the `tracks/new` that publishes our microphone, which is *during*
     * {@link connect} - so joining next to people who are already standing there produced a burst of
     * orders that arrived before there was a publication, were dropped, and were never repeated.
     * Since the same order establishes both the audio and the positional entity, each one lost was a
     * peer who stayed silent and unplaced for the rest of the session.</p>
     */
    async subscribeToPeer(userId: string, peerSessionId: string, trackName: string): Promise<void> {
        const held = this.directives.get(userId);
        const unchanged = held?.peerSessionId === peerSessionId && held?.trackName === trackName;
        // Attempt counts survive a repeated order for the same identity, so the diagnostics show the
        // total spent on a peer rather than resetting each time the relay repeats itself.
        if (!unchanged) this.directives.set(userId, {peerSessionId, trackName, attempts: 0});

        const session = await this.awaitSession();
        if (!session) {
            // Held, not lost. {@link connect} drains whatever is standing the moment a publication
            // exists, which is the only window this can happen in: republish tears the session down
            // before rebuilding it, and an order can land in the gap.
            this.deferredOrders++;
            console.warn('[isle-voice] no proximity publication yet - holding the order to hear a peer', {
                userId,
            });
            return;
        }

        await this.driveSubscribe(session, userId);
    }

    /**
     * Reconcile what we were told to hear against what we actually pulled, and repair the difference.
     *
     * <p><b>Driven by events, and never re-driving a healthy pair.</b> The second half is the part
     * that is forced rather than chosen: the server deliberately does not re-blast currently-audible
     * pairs on its own five-second tick, because a SubscribeMutual can cost the recipient a
     * renegotiation, so anything here that re-pulled peers already being pulled would reintroduce
     * exactly the churn the server declined to cause. This only ever touches the difference - though
     * the filter below is a short-circuit rather than the guarantee: what actually makes a re-pull
     * impossible is the (peer, peer session) dedupe in {@link subscribeQueued}, which is where a
     * change would have to go wrong for a healthy pair to be disturbed.</p>
     *
     * <p>Every transition that can create a difference has an event to hang this on: the publish in
     * {@link connect} (which is what makes the relay re-drive every audible peer), a hub reconnect and
     * `isle.RepublishVoice` (both of which run the full republish through it). The one thing no event
     * covers is a pull that exhausted its retries while nothing else changed, so
     * {@link IsleProximityService} also calls this from the status poll it already runs - reusing that
     * timer rather than adding one, because a peer given up on has no other route back.</p>
     *
     * <p>Concurrently rather than in sequence: on a busy join every peer in the block is ordered at
     * once, and one peer losing a publish race would otherwise hold up everyone behind them.</p>
     */
    async reconcile(): Promise<void> {
        const session = this.session;
        if (!session) return;

        const missing = [...this.directives].filter(
            ([userId, directive]) => this.subscribedSessions.get(userId) !== directive.peerSessionId,
        );
        if (!missing.length) return;

        console.warn('[isle-voice] backfilling peers we were told to hear but are not pulling', {
            count: missing.length,
            userIds: missing.map(([userId]) => userId),
        });
        await Promise.all(missing.map(([userId]) => this.driveSubscribe(session, userId)));
    }

    /**
     * The publication to pull onto, or null if there is none.
     *
     * {@link ready} is exact - it is pending for precisely as long as a connect is in flight - so
     * unlike the guild path's `awaitSession` there is nothing to poll for. What it does not cover is
     * the gap in a republish between the teardown and the next connect, where it is already settled
     * and there is no session; that is what {@link reconcile} is for.
     */
    private async awaitSession(): Promise<VoiceSession | null> {
        await this.ready.catch(() => void 0);
        return this.session;
    }

    /** Run one subscribe for a peer, after every operation already queued for them. */
    private driveSubscribe(session: VoiceSession, userId: string): Promise<void> {
        const next = (this.peerOps.get(userId) ?? Promise.resolve())
            .catch(() => void 0)
            .then(() => this.subscribeQueued(session, userId));
        // The chain is kept settled, or one rejected subscribe takes every later operation for that
        // peer with it.
        this.peerOps.set(
            userId,
            next.catch(() => void 0),
        );
        return next;
    }

    /**
     * One pull, with nothing else in flight for the same peer.
     *
     * <p>The dedupe here is keyed on <b>(peer, peer session)</b>, and both halves matter. Keyed on the
     * peer alone it would suppress the legitimate resubscribe when someone reconnects - and that is
     * not a hypothetical, because the engine's own "already subscribed" guard is keyed on the peer
     * alone: `Publication::subscribe` answers `Ok` for any source it already holds that has a mid
     * route, without looking at the session id it was asked for. A peer who republishes keeps their
     * userId and their track name ("audio") and changes only their session, so a fresh order for them
     * would be answered `Ok` against the dead session and recorded as a success - a silent peer by a
     * different route, and one that never repairs. Dropping the old pull first is what makes the new
     * one reach the wire.</p>
     */
    private async subscribeQueued(session: VoiceSession, userId: string): Promise<void> {
        const directive = this.directives.get(userId);
        // Retracted by isle.PeerLeft while this was queued.
        if (!directive) return;

        const {peerSessionId, trackName} = directive;
        const previous = this.subscribedSessions.get(userId);
        if (previous === peerSessionId) return;

        if (previous !== undefined) {
            console.warn('[isle-voice] peer republished on a new session, resubscribing', {
                userId,
                from: previous,
                to: peerSessionId,
            });
            await this.engine.unsubscribe(session, userId).catch(() => void 0);
            this.subscribedSessions.delete(userId);
            this.peers.update(s => {
                if (!s.has(userId)) return s;
                const n = new Set(s);
                n.delete(userId);
                return n;
            });
        }

        const token = (this.subscribeTokens.get(userId) ?? 0) + 1;
        this.subscribeTokens.set(userId, token);

        for (let attempt = 0; ; attempt++) {
            if (this.subscribeTokens.get(userId) !== token) return;
            directive.attempts++;
            try {
                await this.engine.subscribe(session, userId, peerSessionId, trackName);
                if (this.subscribeTokens.get(userId) !== token) {
                    // Superseded while the call was in flight. Drop what we just took, or it outlives
                    // the peer it belongs to.
                    await this.engine.unsubscribe(session, userId).catch(() => void 0);
                    return;
                }
                this.subscribedSessions.set(userId, peerSessionId);
                delete directive.lastError;
                // Only once their audio is actually in the mixer. Placing someone who was never
                // pulled would leave a position for a source that does not exist.
                this.spatial.addPeer(userId);
                this.peers.update(s => new Set(s).add(userId));
                return;
            } catch (e) {
                directive.lastError = String(e);
                if (attempt < ISLE_SUBSCRIBE_RETRY_DELAYS_MS.length) {
                    console.warn(
                        '[isle-voice] pulling a peer failed, retrying',
                        {
                            userId,
                            attempt: attempt + 1,
                            retryInMs: ISLE_SUBSCRIBE_RETRY_DELAYS_MS[attempt],
                        },
                        e,
                    );
                    await new Promise(r => setTimeout(r, ISLE_SUBSCRIBE_RETRY_DELAYS_MS[attempt]));
                    continue;
                }
                // Loud, and it stays loud. The order is deliberately left standing rather than
                // discarded: nothing has told us this peer is gone, so the next reconcile - a
                // republish, a hub reconnect - gets to try again instead of treating them as handled.
                console.error(
                    '[isle-voice] gave up pulling a peer; they will be silent and unplaced',
                    {userId, peerSessionId, trackName, attempts: ISLE_SUBSCRIBE_RETRY_DELAYS_MS.length + 1},
                    e,
                );
                return;
            }
        }
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
        // The order is retracted, so the reconcile must not put them back. Without this, a peer who
        // leaves during a backoff is resubscribed seconds later and stays in the mix.
        this.directives.delete(userId);
        this.subscribedSessions.delete(userId);
        this.subscribeTokens.set(userId, (this.subscribeTokens.get(userId) ?? 0) + 1);
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
        this.forgetSubscriptions();
    }

    /**
     * Per-peer subscribe state, for `__isleSubs()`.
     *
     * Per entity rather than an aggregate, deliberately. A count of subscribed peers reads healthy
     * while one of them is the peer nobody can hear, which is the shape every media bug in this
     * subsystem has had; what identifies the fault is which peer has an order with no pull, and how
     * many attempts it cost.
     */
    subscribeDiagnostics(): {
        peers: {
            userId: string;
            peerSessionId: string;
            trackName: string;
            pulled: boolean;
            attempts: number;
            lastError?: string;
        }[];
        /** Orders that arrived with no publication to pull them onto, since the last connect. */
        deferredOrders: number;
    } {
        return {
            deferredOrders: this.deferredOrders,
            peers: [...this.directives].map(([userId, d]) => ({
                userId,
                peerSessionId: d.peerSessionId,
                trackName: d.trackName,
                pulled: this.subscribedSessions.get(userId) === d.peerSessionId,
                attempts: d.attempts,
                ...(d.lastError === undefined ? {} : {lastError: d.lastError}),
            })),
        };
    }

    /** Forget every standing order and every recorded pull, and cancel any retry still sleeping. */
    private forgetSubscriptions(): void {
        this.directives.clear();
        this.subscribedSessions.clear();
        // Bumped, not cleared: a cleared map reads as token 0 to a retry that is still sleeping, which
        // is the value it would match if it were the first attempt for that peer.
        for (const [userId, token] of this.subscribeTokens) this.subscribeTokens.set(userId, token + 1);
        // Dropped rather than awaited: anything still queued is for a publication that is going away.
        this.peerOps.clear();
        this.deferredOrders = 0;
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
