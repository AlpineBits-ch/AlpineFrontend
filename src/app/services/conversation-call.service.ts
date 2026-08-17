import {effect, inject, Injectable, signal, untracked} from '@angular/core';
import {OngoingCallDto} from '../dtos/response/ongoing-call.dto';
import {VoiceService} from './voice.service';
import {CallSessionService} from './call-session.service';
import {ConnectionState, RealtimeConnectionService} from './realtime-connection.service';
import {MessagingWebsocketService} from './messaging-websocket.service';

/**
 * Which conversations have a call going on in them right now.
 *
 * <p>Exists because none of the other call signals reach the person who most needs this one.
 * `call.IncomingCall` is addressed to invitees and is never replayed; the pending-call read answers
 * only for someone currently being rung. A member who declined, who hung up and changed their mind,
 * or who was never invited had no way to see that their friends were on a call in the conversation
 * they were looking at.</p>
 *
 * <p>Two sources, deliberately: `conversation.CallStateChanged` keeps this live while connected, and
 * a per-conversation read fills the gap for a conversation opened after the fact - or after a
 * reconnect, since SignalR replays nothing.</p>
 */
@Injectable({providedIn: 'root'})
export class ConversationCallService {
    private voiceService = inject(VoiceService);
    private callSession = inject(CallSessionService);
    private realtime = inject(RealtimeConnectionService);
    private ws = inject(MessagingWebsocketService);

    private readonly calls = signal<Record<string, OngoingCallDto>>({});

    /** Conversations whose snapshot has been fetched, so opening one twice is one request. */
    private readonly fetched = new Set<string>();

    constructor() {
        this.ws.conversationCallStateObservable.subscribe(event => {
            if (event.status === 'Ended') {
                this.forget(event.conversationId);
                return;
            }

            // The event says a call is running and who is on it - enough for the banner without a
            // round trip. `creatorId` is not on the event, and the banner does not need it.
            this.calls.update(calls => ({
                ...calls,
                [event.conversationId]: {
                    ...calls[event.conversationId],
                    callId: event.callId,
                    conversationId: event.conversationId,
                    status: event.participantIds.length > 0 ? 'Connected' : 'Pending',
                    creatorId: calls[event.conversationId]?.creatorId ?? '',
                    startedAt: calls[event.conversationId]?.startedAt ?? new Date().toISOString(),
                    connectedUserIds: event.participantIds,
                },
            }));
        });

        // A reconnect is a gap, and a gap is exactly what this state cannot survive: a call may have
        // started or ended while the socket was down, and neither will be re-announced. Everything
        // known is dropped and re-read on demand rather than left to rot.
        effect(() => {
            if (this.realtime.connectionState() !== ConnectionState.Connected) return;
            untracked(() => {
                this.fetched.clear();
                this.calls.set({});
            });
        });
    }

    /**
     * The call to offer joining in this conversation, or null.
     *
     * <p>Null while this client is already in that call - the call panel is the UI then, and a
     * "join" banner over a call you are on is nonsense.</p>
     *
     * <p>A plain reader over signals rather than a computed factory: callers wrap it in one
     * computed of their own, instead of minting a fresh computed on every change detection pass.</p>
     */
    ongoingIn(conversationId: string): OngoingCallDto | null {
        const call = this.calls()[conversationId];
        if (!call) return null;
        return this.callSession.session()?.callId === call.callId ? null : call;
    }

    /**
     * Reads the current state for one conversation. Called when a conversation is opened; a repeat
     * for the same conversation is skipped, since the live event covers everything after the first.
     */
    refresh(conversationId: string): void {
        if (this.fetched.has(conversationId)) return;
        this.fetched.add(conversationId);

        this.voiceService.getConversationCall(conversationId).subscribe({
            next: call => {
                if (call) this.calls.update(calls => ({...calls, [conversationId]: call}));
                else this.forget(conversationId);
            },
            // Silent, and un-marked so the next open retries: this is a background read whose
            // failure costs a banner, not a call.
            error: () => this.fetched.delete(conversationId),
        });
    }

    private forget(conversationId: string): void {
        this.calls.update(calls => {
            if (!(conversationId in calls)) return calls;
            const next = {...calls};
            delete next[conversationId];
            return next;
        });
    }
}
