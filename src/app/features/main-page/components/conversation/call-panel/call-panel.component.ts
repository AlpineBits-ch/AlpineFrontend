import { Component, effect, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { CallSessionService } from '../../../../../services/call-session.service';
import { CallWebRtcService } from '../../../../../services/call-webrtc.service';
import { CallParticipantUi, ScreenShareUi } from '../../../../../services/call-session.types';
import { SrcObjectDirective } from './src-object.directive';

interface FocusedStream {
  kind: 'camera' | 'share';
  stream: MediaStream;
  label: string;
  mirror: boolean;
}

@Component({
  selector: 'app-call-panel',
  templateUrl: './call-panel.component.html',
  styleUrl: './call-panel.component.css',
  imports: [SrcObjectDirective],
})
export class CallPanelComponent implements OnInit, OnDestroy {
  private callSession = inject(CallSessionService);
  private callWebRtc = inject(CallWebRtcService);

  protected session = this.callSession.session;
  protected stats = this.callWebRtc.stats;
  protected focusedStream = signal<FocusedStream | null>(null);
  protected showStats = signal(false);
  protected duration = '00:00';
  private durationInterval?: ReturnType<typeof setInterval>;

  constructor() {
    effect(() => {
      const focused = this.focusedStream();
      if (!focused) return;
      const s = this.session();
      if (!s) { this.focusedStream.set(null); return; }
      const stillActive = focused.kind === 'camera'
        ? s.participants.some(p => p.videoStream === focused.stream && p.isCameraOn)
        : s.screenShares.some(sh => sh.stream === focused.stream);
      if (!stillActive) this.focusedStream.set(null);
    });
  }

  ngOnInit(): void {
    this.durationInterval = setInterval(() => {
      const s = this.callSession.session();
      if (!s) return;
      const elapsed = Math.floor((Date.now() - new Date(s.startedAt).getTime()) / 1000);
      const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
      const sec = (elapsed % 60).toString().padStart(2, '0');
      this.duration = `${m}:${sec}`;
    }, 1000);
  }

  ngOnDestroy(): void {
    clearInterval(this.durationInterval);
  }

  protected toggleMute():        void { this.callSession.toggleMute(); }
  protected toggleDeafen():      void { this.callSession.toggleDeafen(); }
  protected toggleCamera():      void { void this.callSession.toggleCamera(); }
  protected toggleScreenShare(): void { void this.callSession.toggleScreenShare(); }
  protected joinScreenShare(id: string): void { this.callSession.joinScreenShare(id); }
  protected endCall():           void { this.callSession.end(); }
  protected toggleStats():       void { this.showStats.update(v => !v); }
  protected unfocus():           void { this.focusedStream.set(null); }

  protected focusCamera(p: CallParticipantUi): void {
    if (!p.videoStream) return;
    this.focusedStream.set({
      kind: 'camera',
      stream: p.videoStream,
      label: p.isLocal ? 'You' : p.displayName,
      mirror: p.isLocal,
    });
  }

  protected focusShare(share: ScreenShareUi): void {
    if (!share.stream) return;
    this.focusedStream.set({
      kind: 'share',
      stream: share.stream,
      label: `${share.displayName}'s screen`,
      mirror: false,
    });
  }
}
