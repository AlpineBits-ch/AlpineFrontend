import { inject, Injectable, OnDestroy, signal } from '@angular/core';
import { Subscription } from 'rxjs';
import { CallDto } from '../dtos/response/call.dto';
import { ConversationStore } from '../stores/conversation.store';
import { ProfileService } from './profile.service';
import { VoiceService } from './voice.service';
import { VoiceWebsocketService } from './voice-websocket.service';
import { CallSessionService } from './call-session.service';
import { NavigationService } from '../features/main-page/navigation.service';

export interface IncomingCallState {
  call: CallDto;
  displayName: string;
  avatarLabel: string;
}

export interface OutgoingCallState {
  displayName: string;
  avatarLabel: string;
}

@Injectable({ providedIn: 'root' })
export class CallStateService implements OnDestroy {
  private ws = inject(VoiceWebsocketService);
  private voiceService = inject(VoiceService);
  private profileService = inject(ProfileService);
  private conversationStore = inject(ConversationStore);
  private callSession = inject(CallSessionService);
  private navService = inject(NavigationService);

  readonly incomingCall = signal<IncomingCallState | null>(null);
  readonly outgoingCall = signal<OutgoingCallState | null>(null);

  private ringTimer: ReturnType<typeof setTimeout> | null = null;
  private sub: Subscription;
  private readonly devKeyHandler = (e: KeyboardEvent) => this.handleDevShortcut(e);

  constructor() {
    this.sub = this.ws.incomingCallObservable.subscribe(call => {
      this.incomingCall.set(this.resolveCallInfo(call));
      this.startRingtone();
    });
    document.addEventListener('keydown', this.devKeyHandler);
  }

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
      this.outgoingCall.set({ displayName: 'Bob Testuser', avatarLabel: 'B' });
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
          participants: conv.members.map(m => ({ userId: m.userId })),
        },
        conv.id,
      );
    }
  }

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

    return { call, displayName, avatarLabel };
  }

  startCall(conversationId: string, participants: string[], displayName: string, avatarLabel: string): void {
    this.outgoingCall.set({ displayName, avatarLabel });
    this.startRingback();
    this.voiceService.createCall({ conversationId, participants }).subscribe({
      next: (callDto) => {
        this.stopRingtone();
        this.outgoingCall.set(null);
        this.callSession.join(callDto, conversationId);
      },
      error: () => { this.outgoingCall.set(null); this.stopRingtone(); },
    });
  }

  accept(): void {
    const incoming = this.incomingCall();
    if (!incoming) return;
    this.stopRingtone();
    this.incomingCall.set(null);
    this.voiceService.acceptCall(incoming.call.id).subscribe({
      next: (callDto) => this.callSession.join(callDto, callDto.conversationId),
    });
  }

  reject(): void {
    const incoming = this.incomingCall();
    if (!incoming) return;
    this.stopRingtone();
    this.incomingCall.set(null);
    this.voiceService.declineCall(incoming.call.id).subscribe();
  }

  cancelOutgoing(): void {
    this.stopRingtone();
    this.outgoingCall.set(null);
    // Call is being set up — end it once we have an ID (handled by WebRTC service later)
  }

  // ── Web Audio ────────────────────────────────────────────────────────

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
    if (!this.incomingCall()) return;
    this.playIncomingRing();
    this.ringTimer = setTimeout(() => this.incomingCycle(), 2200);
  }

  private playIncomingRing(): void {
    try {
      const ctx = new AudioContext();
      const pulse = (freq: number, t: number, vol = 0.20) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = freq;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(vol, t + 0.01);
        gain.gain.setValueAtTime(vol, t + 0.09);
        gain.gain.linearRampToValueAtTime(0, t + 0.13);
        osc.start(t);
        osc.stop(t + 0.15);
      };
      // Three ascending notes: E5 → A5 → C6
      pulse(659, ctx.currentTime);
      pulse(880, ctx.currentTime + 0.14);
      pulse(1047, ctx.currentTime + 0.28, 0.18);
      // Repeat the triplet once
      pulse(659, ctx.currentTime + 0.55);
      pulse(880, ctx.currentTime + 0.69);
      pulse(1047, ctx.currentTime + 0.83, 0.18);
      setTimeout(() => ctx.close(), 1200);
    } catch { /* AudioContext unavailable */ }
  }

  // Outgoing ringback: classic dual-tone (440+480 Hz), 2 pulses then silence — repeats every 6s
  private ringbackCycle(): void {
    if (!this.outgoingCall()) return;
    this.playRingback();
    this.ringTimer = setTimeout(() => this.ringbackCycle(), 6000);
  }

  private playRingback(): void {
    try {
      const ctx = new AudioContext();
      const tone = (freq: number, t: number) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = freq;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.12, t + 0.015);
        gain.gain.setValueAtTime(0.12, t + 0.38);
        gain.gain.linearRampToValueAtTime(0, t + 0.42);
        osc.start(t);
        osc.stop(t + 0.45);
      };
      // 440+480 Hz chord, two pulses (classic PSTN ringback)
      tone(440, ctx.currentTime);
      tone(480, ctx.currentTime);
      tone(440, ctx.currentTime + 0.65);
      tone(480, ctx.currentTime + 0.65);
      setTimeout(() => ctx.close(), 1800);
    } catch { /* AudioContext unavailable */ }
  }

  private stopRingtone(): void {
    if (this.ringTimer !== null) {
      clearTimeout(this.ringTimer);
      this.ringTimer = null;
    }
  }

  ngOnDestroy(): void {
    this.stopRingtone();
    this.sub.unsubscribe();
    document.removeEventListener('keydown', this.devKeyHandler);
  }
}
