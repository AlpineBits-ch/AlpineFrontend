import {inject, Injectable, OnDestroy, signal} from '@angular/core';
import {first, map, race, Subscription} from 'rxjs';
import {CallDto} from '../dtos/response/call.dto';
import {ConversationStore} from '../stores/conversation.store';
import {ProfileService} from './profile.service';
import {VoiceService} from './voice.service';
import {VoiceWebsocketService} from './voice-websocket.service';
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
    private ws = inject(VoiceWebsocketService);
    private voiceService = inject(VoiceService);
    private profileService = inject(ProfileService);
    private conversationStore = inject(ConversationStore);
    private callSession = inject(CallSessionService);
    private navService = inject(NavigationService);
    private soundSettings = inject(SoundSettingsService);
    private toast = inject(ToastService);
    private ringTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingCallDto: CallDto | null = null;
    private pendingCallSub: Subscription | null = null;
    private sub: Subscription;
    private incomingEndedSub: Subscription;

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
        this.incomingEndedSub = this.ws.callEndedObservable.subscribe(({callId}) => {
            if (this.incomingCall()?.call.id !== callId) return;
            this.stopRingtone();
            this.incomingCall.set(null);
        });
        document.addEventListener('keydown', this.devKeyHandler);
    }

    startCall(conversationId: string, participants: string[], displayName: string, avatarLabel: string): void {
        this.outgoingCall.set({conversationId, displayName, avatarLabel, startedAt: new Date()});
        this.startRingback();
        this.voiceService.createCall({conversationId, participants}).subscribe({
            next: (callDto) => {
                this.pendingCallDto = callDto;
                // Join immediately so WebRTC listeners are wired up before ParticipantJoined fires.
                // The outgoing overlay stays visible on top until the callee accepts/declines.
                this.callSession.join(callDto, conversationId);
                this.pendingCallSub = race(
                    this.ws.participantJoinedObservable.pipe(first(), map(() => 'joined' as const)),
                    this.ws.callEndedObservable.pipe(first(), map(() => 'ended' as const)),
                ).subscribe(result => {
                    this.pendingCallDto = null;
                    this.pendingCallSub = null;
                    this.stopRingtone();
                    this.outgoingCall.set(null);
                    if (result === 'ended') this.callSession.end();
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
        this.voiceService.acceptCall(incoming.call.id).subscribe({
            next: (callDto) => this.callSession.join(callDto, callDto.conversationId),
            // Most commonly the caller already cancelled - without this, accepting a
            // call that just ended silently dropped you into the conversation with
            // no call session and no explanation.
            error: (err) => this.toast.httpError('Could not join call - it may have ended', err),
        });
    }

    reject(): void {
        const incoming = this.incomingCall();
        if (!incoming) return;
        this.stopRingtone();
        this.incomingCall.set(null);
        this.voiceService.declineCall(incoming.call.id).subscribe({
            error: (err) => this.toast.httpError('Could not decline call', err),
        });
    }

    cancelOutgoing(): void {
        this.pendingCallSub?.unsubscribe();
        this.pendingCallSub = null;
        if (this.pendingCallDto) {
            this.voiceService.endCall(this.pendingCallDto.id).subscribe();
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
        document.removeEventListener('keydown', this.devKeyHandler);
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
            const conv = view.type === 'conversation'
                ? view.conversation
                : this.conversationStore.entities()[0];
            if (!conv) return;
            const ownId = this.profileService.ownProfile()?.userId ?? 'me';
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
        const callerIds = call.participants.map(p => p.userId).filter(id => id !== ownId);

        const conv = this.conversationStore.entities().find(c =>
            callerIds.some(id => c.members.some(m => m.userId === id))
        );

        let displayName = 'Unknown';
        let avatarLabel = '?';

        if (conv) {
            const others = conv.members.filter(m => m.userId !== ownId);
            if (others.length > 0) {
                displayName = others.length === 1
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
