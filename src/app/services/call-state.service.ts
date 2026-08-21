import {effect, inject, Injectable, OnDestroy, signal, untracked} from '@angular/core';
import {filter, first, map, race, Subscription} from 'rxjs';
import {CallDto} from '../dtos/response/call.dto';
import {ConnectionState, RealtimeConnectionService} from './realtime-connection.service';
import {ConversationStore} from '../stores/conversation.store';
import {ProfileService} from './profile.service';
import {VoiceService} from './voice.service';
import {
    declineEndsOutgoingCall,
    describeCallEndedReason,
    VoiceWebsocketService,
} from './voice-websocket.service';
import {CallSessionService} from './call-session.service';
import {NavigationService} from '../features/main-page/navigation.service';
import {SoundSettingsService} from './sound-settings.service';
import {ToastService} from './toast.service';

export interface IncomingCallState {
    call: CallDto;
    displayName: string;
    avatarLabel: string;
}

export interface OutgoingCallState {
    conversationId: string;
    displayName: string;
    avatarLabel: string;
    startedAt: Date;
}

@Injectable({providedIn: 'root'})
export class CallStateService implements OnDestroy {
    readonly incomingCall = signal<IncomingCallState | null>(null);
    readonly outgoingCall = signal<OutgoingCallState | null>(null);
    /**
     * The conversation an answer is in flight for, or null.
     *
     * <p>Both ways into a call - answering a ring and joining one already running - navigate to the
     * conversation first and only then wait on `POST accept`, so for the length of that round trip
     * there is no session and therefore no call panel. The conversation showed the user nothing at
     * all in the meantime, which reads as a click that missed. This is what it renders instead, and
     * what stops the ongoing-call banner's Join button firing a second accept.</p>
     *
     * <p>An id rather than a flag. This service is a singleton and every open conversation reads it,
     * so a bare boolean would put "joining" in whichever conversation the user happened to navigate
     * to while the request was out.</p>
     */
    readonly joiningConversationId = signal<string | null>(null);
    private ws = inject(VoiceWebsocketService);
    private voiceService = inject(VoiceService);
    private profileService = inject(ProfileService);
    private conversationStore = inject(ConversationStore);
    private callSession = inject(CallSessionService);
    private navService = inject(NavigationService);
    private soundSettings = inject(SoundSettingsService);
    private toast = inject(ToastService);
    private realtime = inject(RealtimeConnectionService);
    /** In-flight guard for {@link catchUpOnPendingCall}. A signal so it is read the same way as
     *  every other piece of state here, and so a future consumer (a "checking..." indicator) can
     *  bind to it without this becoming a second source of truth. */
    private readonly catchingUp = signal(false);
    private ringTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingCallDto: CallDto | null = null;
    private pendingCallSub: Subscription | null = null;
    private sub: Subscription;
    private incomingEndedSub: Subscription;
    private deviceSubs: Subscription;

    constructor() {
        this.sub = this.ws.incomingCallObservable.subscribe(call => {
            if (this.callSession.session()) return; // already in a call, ignore late/duplicate events
            this.incomingCall.set(this.resolveCallInfo(call));
            this.startRingtone();
        });
        // The caller may cancel, hang up, or the call may otherwise end before we've
        // accepted/declined - nothing else clears the incoming-call overlay/ringtone
        // in that case, so without this the card and ringing would persist forever
        // and a subsequent Accept click would silently fail against a dead call.
        this.incomingEndedSub = this.ws.callEndedObservable.subscribe(({callId}) =>
            this.dismissIncomingIfMatches(callId),
        );

        // Three further ways this device's ring stops without it being the one that acted.
        // Without these the card and ringtone persist after another of the user's devices deals
        // with the call, and a later Accept click fails silently against a call that moved on.
        this.deviceSubs = new Subscription();
        this.deviceSubs.add(
            this.ws.callAcceptedObservable.subscribe(({callId}) => this.dismissIncomingIfMatches(callId)),
        );
        this.deviceSubs.add(
            this.ws.callDeviceDismissedObservable.subscribe(({callId}) =>
                this.dismissIncomingIfMatches(callId),
            ),
        );
        this.deviceSubs.add(
            this.ws.callDeviceTakeoverObservable.subscribe(({callId}) => {
                if (this.callSession.session()?.callId !== callId) return;
                // The server has already moved the session to the other device, so tear down
                // silently - calling leave here would drop us out of the call we just joined there.
                this.callSession.end(true);
                this.toast.info('You joined this call on another device');
            }),
        );

        // `call.IncomingCall` is broadcast once and never replayed, so every way of not being
        // connected at that instant ends with the same silence: somebody is calling and this client
        // shows nothing. The app opened while the phone was already ringing is the common one - the
        // socket connects seconds after the event went out - and a reconnect after a dropped
        // connection has exactly the same gap. Ask the server instead of hoping.
        //
        // An effect rather than a transition check: it runs once on creation with whatever the
        // connection state already is, which is the cold-start case (this service is constructed
        // lazily, often after the socket is already up), and again on every change.
        //
        // `connectionState` is the effect's only dependency, hence the untracked call: everything
        // downstream reads `session()`, `incomingCall()` and `catchingUp()`, and tracking those
        // would re-run this on every ring, answer and hang-up.
        effect(() => {
            if (this.realtime.connectionState() !== ConnectionState.Connected) return;
            untracked(() => this.catchUpOnPendingCall());
        });

        document.addEventListener('keydown', this.devKeyHandler);
    }

    /**
     * Asks the server whether a call is ringing for this user that this client was never told
     * about, and raises the incoming-call card if so.
     *
     * Cheap enough to run on every connect: the answer is 204-with-no-body essentially always, and
     * the guards below mean it never disturbs a call already in progress or one already ringing.
     */
    private catchUpOnPendingCall(): void {
        if (this.catchingUp()) return;
        if (this.callSession.session() || this.incomingCall()) return;
        this.catchingUp.set(true);
        this.voiceService.getPendingCall().subscribe({
            next: call => {
                this.catchingUp.set(false);
                if (!call) return;
                // Re-checked after the round trip: the real `call.IncomingCall` landing, or the
                // user starting a call of their own, both leave state this must not overwrite.
                if (this.callSession.session() || this.incomingCall()) return;
                this.incomingCall.set(this.resolveCallInfo(call));
                this.startRingtone();
            },
            // Silent: this is a background catch-up nobody asked for, and the next connect - or the
            // live event, or the call push - tries again.
            error: () => {
                this.catchingUp.set(false);
            },
        });
    }

    startCall(
        conversationId: string,
        participants: string[],
        displayName: string,
        avatarLabel: string,
    ): void {
        this.outgoingCall.set({conversationId, displayName, avatarLabel, startedAt: new Date()});
        this.startRingback();
        this.voiceService.createCall({conversationId, participants}).subscribe({
            next: callDto => {
                this.pendingCallDto = callDto;
                // Join immediately so WebRTC listeners are wired up before ParticipantJoined fires.
                // The outgoing overlay stays visible on top until the callee accepts/declines.
                this.callSession.join(callDto, conversationId);
                this.pendingCallSub = race(
                    // The answer itself, and the only arm that does not depend on the media plane.
                    //
                    // `ParticipantJoined` below is what this used to rely on alone, and it is a
                    // poor proxy for "they picked up": the server raises it once, when the
                    // answering client publishes a microphone, addressed only to people already in
                    // the voice room. This client is not in that room until its own Rust publisher
                    // opens a primary session, seconds after the call is placed - `POST /call` does
                    // not admit anyone, and the webview's own session is secondary. A callee who
                    // answers inside that window publishes into a room we are not in, and nothing
                    // repeats the announcement. Audio still recovers, because the snapshot backfill
                    // repairs it; the ringback could not, because that backfill writes straight
                    // into CallSessionService and never reaches this observable. That is the
                    // "answered on the phone, desktop rings forever" bug.
                    this.ws.callAcceptedObservable.pipe(
                        filter(e => e.callId === callDto.id),
                        first(),
                        map(() => 'accepted' as const),
                    ),
                    this.ws.participantJoinedObservable.pipe(
                        first(),
                        map(() => 'joined' as const),
                    ),
                    this.ws.callEndedObservable.pipe(
                        first(),
                        map(() => 'ended' as const),
                    ),
                    // The other side saying no. Filtered rather than taken outright: a decline in a
                    // group call names one invitee while the rest keep ringing, and race only
                    // commits to a source that actually emits, so a non-final decline leaves the
                    // other two arms live. Without this the caller rang until the alone-timeout.
                    this.ws.callDeclinedObservable.pipe(
                        filter(
                            call =>
                                call.id === callDto.id &&
                                declineEndsOutgoingCall(call, this.profileService.ownProfile()?.userId),
                        ),
                        first(),
                        map(() => 'declined' as const),
                    ),
                ).subscribe(result => {
                    this.pendingCallDto = null;
                    this.pendingCallSub = null;
                    this.stopRingtone();
                    this.outgoingCall.set(null);
                    if (result === 'ended') this.callSession.end();
                    if (result === 'declined') {
                        // Silent, for the same reason `CallDeviceTakeover` is: the server has
                        // already marked the call Rejected, so `leave` would be a request against a
                        // participant record that is gone. The toast is ours to raise because the
                        // matching `CallEnded` - if the server sends one at all - now finds no
                        // session and stays quiet.
                        this.callSession.end(true);
                        this.toast.info(describeCallEndedReason('Declined'));
                    }
                });
            },
            error: () => {
                this.outgoingCall.set(null);
                this.stopRingtone();
            },
        });
    }

    accept(): void {
        const incoming = this.incomingCall();
        if (!incoming) return;
        this.stopRingtone();
        this.incomingCall.set(null);
        const conv = this.conversationStore.entities().find(c => c.id === incoming.call.conversationId);
        if (conv) this.navService.openConversation(conv);
        this.joiningConversationId.set(incoming.call.conversationId);
        this.voiceService.acceptCall(incoming.call.id).subscribe({
            next: callDto => {
                this.joiningConversationId.set(null);
                this.callSession.join(callDto, callDto.conversationId);
            },
            // Most commonly the caller already cancelled - without this, accepting a
            // call that just ended silently dropped you into the conversation with
            // no call session and no explanation.
            error: err => {
                this.joiningConversationId.set(null);
                this.toast.httpError('Could not join call - it may have ended', err);
            },
        });
    }

    /**
     * Joins a call that is already running in a conversation, from the banner rather than from a
     * ring.
     *
     * <p>Goes through accept, same as answering: the server resolves the caller's own participant
     * row, so somebody who declined earlier or hung up and came back is reconnected by it. A member
     * who was never invited to this call has no row to resolve, and the server will not conjure one
     * - the error path below is what they see.</p>
     */
    joinOngoing(callId: string, conversationId: string): void {
        // The banner stays on screen for the whole round trip, so its button is the one control in
        // this service that can be pressed twice against the same call.
        if (this.joiningConversationId()) return;
        this.dismissIncomingIfMatches(callId);
        // Taken from the caller rather than waited for in the response: the banner it belongs to is
        // on screen now, and the response is the thing being waited on.
        this.joiningConversationId.set(conversationId);
        this.voiceService.acceptCall(callId).subscribe({
            next: callDto => {
                this.joiningConversationId.set(null);
                this.callSession.join(callDto, callDto.conversationId);
            },
            error: err => {
                this.joiningConversationId.set(null);
                this.toast.httpError('Could not join call - it may have ended', err);
            },
        });
    }

    reject(): void {
        const incoming = this.incomingCall();
        if (!incoming) return;
        this.stopRingtone();
        this.incomingCall.set(null);
        this.voiceService.declineCall(incoming.call.id).subscribe({
            error: err => this.toast.httpError('Could not decline call', err),
        });
    }

    cancelOutgoing(): void {
        this.pendingCallSub?.unsubscribe();
        this.pendingCallSub = null;
        if (this.pendingCallDto) {
            // Cancelling before anyone answers is "the only connected participant leaves", which
            // the server models as leave - dropping to zero ends the call immediately.
            this.voiceService.leaveCall(this.pendingCallDto.id).subscribe();
            this.pendingCallDto = null;
        }
        this.stopRingtone();
        this.outgoingCall.set(null);
    }

    ngOnDestroy(): void {
        this.pendingCallSub?.unsubscribe();
        this.stopRingtone();
        this.sub.unsubscribe();
        this.incomingEndedSub.unsubscribe();
        this.deviceSubs.unsubscribe();
        document.removeEventListener('keydown', this.devKeyHandler);
    }

    /** Shared by every event that ends this device's ring without this device having acted. */
    private dismissIncomingIfMatches(callId: string): void {
        if (this.incomingCall()?.call.id !== callId) return;
        this.stopRingtone();
        this.incomingCall.set(null);
    }

    private readonly devKeyHandler = (e: KeyboardEvent) => this.handleDevShortcut(e);

    // Ctrl+Alt+I → fake incoming  |  Ctrl+Alt+O → fake outgoing  |  Ctrl+Alt+C → fake active call
    private handleDevShortcut(e: KeyboardEvent): void {
        if (!e.ctrlKey || !e.altKey) return;

        if (e.key === 'I') {
            e.preventDefault();
            this.incomingCall.set({
                call: {
                    id: 'dev-fake',
                    conversationId: 'dev-conv',
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    tracks: [],
                    participants: [],
                },
                displayName: 'Alice Devman',
                avatarLabel: 'A',
            });
            this.startRingtone();
        } else if (e.key === 'O') {
            e.preventDefault();
            this.outgoingCall.set({
                conversationId: 'dev-conv',
                displayName: 'Bob Testuser',
                avatarLabel: 'B',
                startedAt: new Date(),
            });
            this.startRingback();
        } else if (e.key === 'C') {
            e.preventDefault();
            // If already in a call, end it (toggle behaviour)
            if (this.callSession.session()) {
                this.callSession.end();
                return;
            }
            // Use the currently open conversation, fall back to first in store
            const view = this.navService.mainView();
            const conv =
                view.type === 'conversation' ? view.conversation : this.conversationStore.entities()[0];
            if (!conv) return;
            // Participants = all actual members of the conversation
            this.callSession.join(
                {
                    id: 'dev-call',
                    conversationId: conv.id,
                    createdAt: new Date(),
                    updatedAt: new Date(),
                    tracks: [],
                    participants: conv.members.map(m => ({userId: m.userId})),
                },
                conv.id,
            );
        }
    }

    // ── Web Audio ────────────────────────────────────────────────────────

    private resolveCallInfo(call: CallDto): IncomingCallState {
        const ownId = this.profileService.ownProfile()?.userId;
        // `creatorId` when the server sent one: filtering the roster picks an arbitrary invitee
        // once a call has three people in it, and with no own profile loaded yet it matches
        // everyone - including this user - so the card can end up naming its own recipient.
        const callerIds = call.creatorId
            ? [call.creatorId]
            : call.participants.map(p => p.userId).filter(id => id !== ownId);

        const conv = this.conversationStore
            .entities()
            .find(c => callerIds.some(id => c.members.some(m => m.userId === id)));

        let displayName = 'Unknown';
        let avatarLabel = '?';

        if (conv) {
            const others = conv.members.filter(m => m.userId !== ownId);
            if (others.length > 0) {
                displayName =
                    others.length === 1
                        ? others[0].cachedUserName
                        : others.map(m => m.cachedUserName).join(', ');
                avatarLabel = (others[0].cachedUserName?.[0] ?? '?').toUpperCase();
            }
        }

        return {call, displayName, avatarLabel};
    }

    private startRingtone(): void {
        this.stopRingtone();
        this.incomingCycle();
    }

    private startRingback(): void {
        this.stopRingtone();
        this.ringbackCycle();
    }

    // Incoming: urgent ascending 3-note arpeggio, repeats every 2.2s
    private incomingCycle(): void {
        if (!this.incomingCall() || this.callSession.session()) {
            this.incomingCall.set(null);
            return;
        }
        this.playIncomingRing();
        this.ringTimer = setTimeout(() => this.incomingCycle(), 2200);
    }

    private playIncomingRing(): void {
        this.soundSettings.playIncomingRing();
    }

    // Outgoing ringback: classic dual-tone (440+480 Hz), 2 pulses then silence -repeats every 6s
    private ringbackCycle(): void {
        if (!this.outgoingCall()) return;
        this.playRingback();
        this.ringTimer = setTimeout(() => this.ringbackCycle(), 6000);
    }

    private playRingback(): void {
        this.soundSettings.playRingback();
    }

    private stopRingtone(): void {
        if (this.ringTimer !== null) {
            clearTimeout(this.ringTimer);
            this.ringTimer = null;
        }
    }
}
