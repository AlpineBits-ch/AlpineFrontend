import { Component, computed, effect, HostListener, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { CallSessionService } from '../../../../../services/call-session.service';
import { CallWebRtcService } from '../../../../../services/call-webrtc.service';
import { RustMediaService, StreamResolution } from '../../../../../services/rust-media.service';
import { CallParticipant, CallParticipantMenuData, CallScreenShare } from '../../../../../shared/call/call.types';
import { CallParticipantTileComponent } from '../../../../../shared/call/call-participant-tile/call-participant-tile.component';
import { CallControlsBarComponent } from '../../../../../shared/call/call-controls-bar/call-controls-bar.component';
import { CallScreenLayoutComponent } from '../../../../../shared/call/call-screen-layout/call-screen-layout.component';
import { CallContextMenuComponent } from '../../../../../shared/call/call-context-menu/call-context-menu.component';
import { StreamSrcDirective } from '../../../../../directives/stream-src.directive';

interface FocusedStream {
  kind: 'camera' | 'share';
  stream: MediaStream;
  label: string;
  mirror: boolean;
}

const MIN_HEIGHT         = 200;
const MAX_HEIGHT         = 900;
const DEFAULT_HEIGHT     = 420;
const FOCUSED_MIN_HEIGHT = 500;

@Component({
  selector: 'app-call-panel',
  templateUrl: './call-panel.component.html',
  styleUrl: './call-panel.component.css',
  imports: [
    StreamSrcDirective,
    CallParticipantTileComponent,
    CallControlsBarComponent,
    CallScreenLayoutComponent,
    CallContextMenuComponent,
  ],
})
export class CallPanelComponent implements OnInit, OnDestroy {
  private callSession  = inject(CallSessionService);
  private callWebRtc   = inject(CallWebRtcService);
  protected rustMedia  = inject(RustMediaService);

  readonly fpsList        = [5, 10, 15, 30] as const;
  readonly resolutionList = ['native', '1440p', '1080p', '720p', '480p'] as const;

  protected session               = this.callSession.session;
  protected stats                 = this.callWebRtc.stats;
  protected rtcState              = this.callWebRtc.rtcState;
  protected participantsWithAudio = this.callWebRtc.participantsWithAudio;
  protected focusedStream         = signal<FocusedStream | null>(null);
  protected showStats             = signal(false);
  protected participantMenu       = signal<CallParticipantMenuData | null>(null);
  protected panelHeight           = signal(DEFAULT_HEIGHT);
  protected isResizing            = signal(false);
  protected duration              = '00:00';
  private durationInterval?: ReturnType<typeof setInterval>;
  private resizeStartY      = 0;
  private resizeStartHeight = 0;

  // ── Shared-type projections ────────────────────────────────────────────────

  protected callParticipants = computed((): CallParticipant[] => this.session()?.participants ?? []);

  protected callScreenShares = computed((): CallScreenShare[] =>
    (this.session()?.screenShares ?? []).map(sh => ({
      shareId:      sh.shareId,
      userId:       sh.userId,
      displayName:  sh.displayName,
      avatarLabel:  sh.displayName[0]?.toUpperCase() ?? '?',
      isLocal:      sh.isLocal,
      stream:       sh.stream,
      hasAudio:     false,  // DM screen share does not capture audio yet
      isAudioMuted: false,
    }))
  );

  constructor() {
    // Auto-unfocus when the focused stream becomes inactive
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
      const m   = Math.floor(elapsed / 60).toString().padStart(2, '0');
      const sec = (elapsed % 60).toString().padStart(2, '0');
      this.duration = `${m}:${sec}`;
    }, 1000);
  }

  ngOnDestroy(): void {
    clearInterval(this.durationInterval);
  }

  // ── Resize ─────────────────────────────────────────────────────────────────

  protected onResizeStart(event: MouseEvent): void {
    this.isResizing.set(true);
    this.resizeStartY      = event.clientY;
    this.resizeStartHeight = this.panelHeight();
    event.preventDefault();
  }

  @HostListener('document:mousemove', ['$event'])
  protected onMouseMove(event: MouseEvent): void {
    if (!this.isResizing()) return;
    this.panelHeight.set(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, this.resizeStartHeight + (event.clientY - this.resizeStartY))));
  }

  @HostListener('document:mouseup')
  protected onMouseUp(): void { this.isResizing.set(false); }

  // ── Context menu ──────────────────────────────────────────────────────────

  @HostListener('document:click')
  protected closeMenu(): void { this.participantMenu.set(null); }

  @HostListener('document:keydown.escape')
  protected closeMenuKey(): void { this.participantMenu.set(null); }

  // ── Actions ────────────────────────────────────────────────────────────────

  protected toggleMute():        void { this.callSession.toggleMute(); }
  protected toggleDeafen():      void { this.callSession.toggleDeafen(); }
  protected toggleCamera():      void { void this.callSession.toggleCamera(); }
  protected toggleScreenShare(): void { void this.callSession.toggleScreenShare(); }
  protected setCaptureFps(fps: number): void { void this.rustMedia.setCaptureFps(fps); }
  protected setScreenResolution(res: StreamResolution): void { void this.rustMedia.setScreenResolution(res); }
  protected endCall():           void { this.callSession.end(); }
  protected toggleStats():       void { this.showStats.update(v => !v); }
  protected unfocus():           void { this.focusedStream.set(null); }

  protected toggleMaximize(): void {
    this.panelHeight.update(h => h >= MAX_HEIGHT ? DEFAULT_HEIGHT : MAX_HEIGHT);
  }

  protected toggleFullscreen(el: HTMLElement): void {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => void 0);
    } else {
      el.requestFullscreen().catch(() => void 0);
    }
  }

  protected async requestPiP(videoEl: HTMLVideoElement): Promise<void> {
    if (!document.pictureInPictureEnabled) return;
    try {
      if (document.pictureInPictureElement === videoEl) {
        await document.exitPictureInPicture();
      } else {
        await videoEl.requestPictureInPicture();
      }
    } catch { /* denied or unavailable */ }
  }

  protected focusCamera(p: CallParticipant): void {
    if (!p.videoStream) return;
    this.focusedStream.set({ kind: 'camera', stream: p.videoStream, label: p.isLocal ? 'You' : p.displayName, mirror: p.isLocal });
  }

  protected focusShare(share: CallScreenShare): void {
    if (!share.stream) return;
    this.focusedStream.set({ kind: 'share', stream: share.stream, label: `${share.displayName}'s screen`, mirror: false });
  }

  protected onParticipantContextMenu(event: MouseEvent, p: CallParticipant): void {
    if (p.isLocal) return;
    event.preventDefault();
    event.stopPropagation();
    const volume = Math.round(this.callWebRtc.getUserVolume(p.userId) * 100);
    this.participantMenu.set({ x: event.clientX, y: event.clientY, participant: p, volume });
  }

  protected onVolumeChange(value: number): void {
    const menu = this.participantMenu();
    if (!menu) return;
    this.participantMenu.set({ ...menu, volume: value });
    this.callWebRtc.setUserVolume(menu.participant.userId, value / 100);
  }
}
