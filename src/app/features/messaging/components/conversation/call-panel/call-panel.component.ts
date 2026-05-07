import { Component, effect, HostListener, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { CallSessionService } from '../../../../../services/call-session.service';
import { CallWebRtcService } from '../../../../../services/call-webrtc.service';
import { RustMediaService } from '../../../../../services/rust-media.service';
import { CallParticipantUi, ScreenShareUi } from '../../../../../services/call-session.types';
import { SrcObjectDirective } from './src-object.directive';

interface FocusedStream {
  kind: 'camera' | 'share';
  stream: MediaStream;
  label: string;
  mirror: boolean;
}

interface VolumeMenu {
  x: number;
  y: number;
  userId: string;
  displayName: string;
  volume: number; // 0–100
}

const MIN_HEIGHT = 200;
const MAX_HEIGHT = 900;
const DEFAULT_HEIGHT = 420;
const FOCUSED_MIN_HEIGHT = 500;

@Component({
  selector: 'app-call-panel',
  templateUrl: './call-panel.component.html',
  styleUrl: './call-panel.component.css',
  imports: [SrcObjectDirective],
})
export class CallPanelComponent implements OnInit, OnDestroy {
  private callSession = inject(CallSessionService);
  private callWebRtc = inject(CallWebRtcService);
  protected rustMedia = inject(RustMediaService);

  readonly fpsList = [5, 10, 15, 30] as const;

  protected session = this.callSession.session;
  protected stats = this.callWebRtc.stats;
  protected rtcState = this.callWebRtc.rtcState;
  protected participantsWithAudio = this.callWebRtc.participantsWithAudio;
  protected focusedStream = signal<FocusedStream | null>(null);
  protected showStats = signal(false);
  protected volumeMenu = signal<VolumeMenu | null>(null);
  protected panelHeight = signal(DEFAULT_HEIGHT);
  protected isResizing = signal(false);
  protected duration = '00:00';
  private durationInterval?: ReturnType<typeof setInterval>;
  private resizeStartY = 0;
  private resizeStartHeight = 0;

  constructor() {
    // Auto-unfocus when the focused stream is no longer active
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

    // Ensure panel is tall enough to comfortably show the focused video
    effect(() => {
      if (this.focusedStream()) {
        this.panelHeight.update(h => Math.max(h, FOCUSED_MIN_HEIGHT));
      }
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

  // ── Resize ───────────────────────────────────────────────────────────────

  protected onResizeStart(event: MouseEvent): void {
    this.isResizing.set(true);
    this.resizeStartY = event.clientY;
    this.resizeStartHeight = this.panelHeight();
    event.preventDefault();
  }

  @HostListener('document:mousemove', ['$event'])
  protected onMouseMove(event: MouseEvent): void {
    if (!this.isResizing()) return;
    const delta = event.clientY - this.resizeStartY;
    const next = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, this.resizeStartHeight + delta));
    this.panelHeight.set(next);
  }

  @HostListener('document:mouseup')
  protected onMouseUp(): void {
    this.isResizing.set(false);
  }

  // ── Menu / volume ─────────────────────────────────────────────────────────

  @HostListener('document:click')
  protected closeVolumeMenu(): void { this.volumeMenu.set(null); }

  @HostListener('document:keydown.escape')
  protected closeVolumeMenuKey(): void { this.volumeMenu.set(null); }

  // ── Actions ───────────────────────────────────────────────────────────────

  protected toggleMute():        void { this.callSession.toggleMute(); }
  protected toggleDeafen():      void { this.callSession.toggleDeafen(); }
  protected toggleCamera():      void { void this.callSession.toggleCamera(); }
  protected toggleScreenShare(): void { void this.callSession.toggleScreenShare(); }
  protected setCaptureFps(fps: number): void { void this.rustMedia.setCaptureFps(fps); }
  protected joinScreenShare(id: string): void { this.callSession.joinScreenShare(id); }
  protected endCall():           void { this.callSession.end(); }
  protected toggleStats():       void { this.showStats.update(v => !v); }
  protected unfocus():           void { this.focusedStream.set(null); }

  protected toggleFullscreen(el: HTMLElement): void {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => void 0);
    } else {
      el.requestFullscreen().catch(() => void 0);
    }
  }

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

  protected onTileContextMenu(event: MouseEvent, p: CallParticipantUi): void {
    if (p.isLocal) return;
    event.preventDefault();
    const volume = Math.round(this.callWebRtc.getUserVolume(p.userId) * 100);
    this.volumeMenu.set({ x: event.clientX, y: event.clientY, userId: p.userId, displayName: p.displayName, volume });
  }

  protected onVolumeInput(event: Event): void {
    const value = parseInt((event.target as HTMLInputElement).value, 10);
    const menu = this.volumeMenu();
    if (!menu) return;
    this.volumeMenu.set({ ...menu, volume: value });
    this.callWebRtc.setUserVolume(menu.userId, value / 100);
  }
}
