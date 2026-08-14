import {Component, computed, effect, HostListener, inject, OnDestroy, OnInit, signal} from '@angular/core';
import {CallSessionService} from '../../../../../services/call-session.service';
import {CallWebRtcService} from '../../../../../services/call-webrtc.service';
import {RustMediaService} from '../../../../../services/rust-media.service';
import {StreamPreset} from '../../../../../models/stream-preset';
import {CallParticipant, CallParticipantMenuData, CallScreenShare} from '../../../../../shared/call/call.types';
import {trackAudioWait} from '../../../../../shared/call/audio-wait';
import {
  CallParticipantTileComponent
} from '../../../../../shared/call/call-participant-tile/call-participant-tile.component';
import {CallControlsBarComponent} from '../../../../../shared/call/call-controls-bar/call-controls-bar.component';
import {CallScreenLayoutComponent} from '../../../../../shared/call/call-screen-layout/call-screen-layout.component';
import {CallContextMenuComponent} from '../../../../../shared/call/call-context-menu/call-context-menu.component';
import {CallStatusBarComponent} from '../../../../../shared/call/call-status-bar/call-status-bar.component';
import {CallStatsPopoverComponent} from '../../../../../shared/call/call-stats-popover/call-stats-popover.component';
import {formatAloneDeadline} from './alone-countdown';
import {WatchScope} from '../../../../../services/share-watch.service';
import {TranslateModule, TranslateService} from '@ngx-translate/core';

const MIN_HEIGHT = 200;
const MAX_HEIGHT = 900;
const DEFAULT_HEIGHT = 420;

const CHIP_BASE = 'call-focusable flex size-[1.375rem] shrink-0 cursor-pointer items-center justify-center'
    + ' rounded border-0 bg-transparent transition-colors';

@Component({
    selector: 'app-call-panel',
    templateUrl: './call-panel.component.html',
    styleUrl: './call-panel.component.css',
    imports: [
        CallParticipantTileComponent,
        CallControlsBarComponent,
        CallScreenLayoutComponent,
        CallContextMenuComponent,
        CallStatusBarComponent,
        CallStatsPopoverComponent,
        TranslateModule,
    ],
})
export class CallPanelComponent implements OnInit, OnDestroy {
    readonly fpsList = [5, 10, 15, 30] as const;
    readonly resolutionList = ['native', '1440p', '1080p', '720p', '480p'] as const;
    protected rustMedia = inject(RustMediaService);
    protected showStats = signal(false);
    protected participantMenu = signal<CallParticipantMenuData | null>(null);
    protected panelHeight = signal(DEFAULT_HEIGHT);
    protected isResizing = signal(false);
    /** A signal, not a field: it is bound into the status bar, which is OnPush. */
    protected duration = signal('00:00');
    /** Named rather than comparing the height to a literal 900 at the point of use. */
    protected isMaximized = computed(() => this.panelHeight() >= MAX_HEIGHT);
    private callSession = inject(CallSessionService);
    private callWebRtc = inject(CallWebRtcService);
    private translate = inject(TranslateService);
    protected callParticipants = computed((): CallParticipant[] => this.session()?.participants ?? []);
    protected callScreenShares = computed((): CallScreenShare[] =>
        (this.session()?.screenShares ?? []).map(sh => ({
            shareId: sh.shareId,
            userId: sh.userId,
            displayName: sh.displayName,
            avatarLabel: sh.displayName[0]?.toUpperCase() ?? '?',
            isLocal: sh.isLocal,
            stream: sh.stream,
            previewSrc: sh.isLocal ? this.rustMedia.publishPreview() : null,
            // Own share: what the publisher actually opened, since a machine with no usable loopback
            // device shares video only. Remote share: assumed present, exactly as the guild tiles
            // do - the mute is a preference about that person's stream and is harmless to offer for
            // one that turns out to be silent.
            hasAudio: sh.isLocal ? this.callSession.localScreenHasAudio() : true,
            isAudioMuted: sh.isLocal
                ? this.callSession.localScreenAudioMuted()
                : this.callWebRtc.isScreenAudioMuted(sh.userId),
            // Read off the inbound-rtp video stat for this share's own track - see
            // CallWebRtcService.inboundVideoFpsByShare. Keyed by share id, not user id:
            // CallSessionService.onScreenShareStarted dedupes incoming shares by shareId alone, so a
            // stale share can briefly sit in the model alongside its replacement under the same
            // userId (a rapid stop/restart race) - keying by user would make one silently report the
            // other's number. Left at null rather than 0 when the stat has not arrived yet, so a
            // stream that just started and one that has stalled do not look the same
            // (CallScreenShare.inboundFps).
            inboundFps: sh.isLocal ? null : (this.callWebRtc.inboundVideoFpsByShare()[sh.shareId] ?? null),
        }))
    );
    protected session = this.callSession.session;
    /** Where these shares live, so watching them can be announced - see ShareWatchService. */
    protected watchScope = computed((): WatchScope | null => {
        const callId = this.session()?.callId;
        return callId ? {kind: 'call', callId} : null;
    });

    /**
     * Resolves a viewer count popover's user ids against this call's own roster - see
     * CallScreenLayoutComponent.nameOf for why the layout takes this as an input rather than
     * reaching for a call-participant lookup itself. Only someone in the call can watch a share in
     * it, so this roster is enough; the translated fallback below is only ever seen for a viewer
     * whose join has not reached this client yet, and should be brief in practice - never the raw
     * user id, which is an internal identifier with no business appearing in a user-facing popover.
     */
    protected readonly resolveParticipantName = (userId: string): string =>
        this.callParticipants().find(p => p.userId === userId)?.displayName
        ?? this.translate.instant('CALL.UNKNOWN_VIEWER');
    protected screenPreset = this.callSession.screenPreset;
    /** Set only while the local user is the last one in the call. */
    protected aloneUntil = computed(() => formatAloneDeadline(this.callSession.aloneDeadline()));
    protected stats = this.callWebRtc.stats;
    protected rtcState = this.callWebRtc.rtcState;
    protected participantsWithAudio = this.callWebRtc.participantsWithAudio;
    protected audio = trackAudioWait(this.callParticipants, this.participantsWithAudio);
    private durationInterval?: ReturnType<typeof setInterval>;

    /** Mute the sound of the share this client is publishing. */
    protected toggleLocalScreenAudio(): void {
        this.callSession.toggleLocalScreenAudio();
    }

    /** Mute one participant's shared stream, leaving their voice alone. */
    protected toggleRemoteScreenAudio(userId: string): void {
        this.callWebRtc.toggleScreenAudioMute(userId);
    }


    // ── Shared-type projections ────────────────────────────────────────────────
    private resizeStartY = 0;
    private resizeStartHeight = 0;

    ngOnInit(): void {
        this.durationInterval = setInterval(() => {
            const s = this.callSession.session();
            if (!s) return;
            const elapsed = Math.floor((Date.now() - new Date(s.startedAt).getTime()) / 1000);
            const m = Math.floor(elapsed / 60).toString().padStart(2, '0');
            const sec = (elapsed % 60).toString().padStart(2, '0');
            this.duration.set(`${m}:${sec}`);
        }, 1000);
    }

    ngOnDestroy(): void {
        clearInterval(this.durationInterval);
    }

    // ── Resize ─────────────────────────────────────────────────────────────────

    protected onResizeStart(event: MouseEvent): void {
        this.isResizing.set(true);
        this.resizeStartY = event.clientY;
        this.resizeStartHeight = this.panelHeight();
        event.preventDefault();
    }

    @HostListener('document:mousemove', ['$event'])
    protected onMouseMove(event: MouseEvent): void {
        if (!this.isResizing()) return;
        this.panelHeight.set(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, this.resizeStartHeight + (event.clientY - this.resizeStartY))));
    }

    @HostListener('document:mouseup')
    protected onMouseUp(): void {
        this.isResizing.set(false);
    }

    // ── Context menu ──────────────────────────────────────────────────────────

    @HostListener('document:click')
    protected closeMenu(): void {
        this.participantMenu.set(null);
    }

    @HostListener('document:keydown.escape')
    protected closeMenuKey(): void {
        this.participantMenu.set(null);
    }

    // ── Actions ────────────────────────────────────────────────────────────────

    protected toggleMute(): void {
        this.callSession.toggleMute();
    }

    protected toggleDeafen(): void {
        this.callSession.toggleDeafen();
    }

    protected toggleCamera(): void {
        void this.callSession.toggleCamera();
    }

    protected toggleScreenShare(): void {
        void this.callSession.toggleScreenShare();
    }

    protected setScreenPreset(preset: StreamPreset): void {
        void this.callSession.setScreenPreset(preset);
    }

    protected endCall(): void {
        this.callSession.end();
    }

    protected toggleStats(): void {
        this.showStats.update(v => !v);
    }

    protected toggleMaximize(): void {
        this.panelHeight.set(this.isMaximized() ? DEFAULT_HEIGHT : MAX_HEIGHT);
    }

    /** The two small square buttons that sit at the end of the status row. */
    protected chipClass(active: boolean): string {
        return active
            ? `${CHIP_BASE} bg-brand/15 text-brand-dim`
            : `${CHIP_BASE} text-white/40 hover:bg-white/[0.08] hover:text-white/70`;
    }

    // A focused-stream view used to live here, with the only fullscreen button in the app on it -
    // and nothing ever opened it: no tile had a click handler bound to the focus methods, so the
    // whole view, and fullscreen with it, was unreachable. Fullscreen and picture-in-picture now
    // live on the tiles themselves, in call-screen-layout and call-participant-tile, where both
    // call surfaces get them.

    protected onParticipantContextMenu(event: MouseEvent, p: CallParticipant): void {
        if (p.isLocal) return;
        event.preventDefault();
        event.stopPropagation();
        const volume = Math.round(this.callWebRtc.getUserVolume(p.userId) * 100);
        const x = Math.min(event.clientX, window.innerWidth - 236);
        const y = Math.min(event.clientY, window.innerHeight - 200);
        this.participantMenu.set({x: Math.max(0, x), y: Math.max(0, y), participant: p, volume});
    }

    protected onVolumeChange(value: number): void {
        const menu = this.participantMenu();
        if (!menu) return;
        this.participantMenu.set({...menu, volume: value});
        this.callWebRtc.setUserVolume(menu.participant.userId, value / 100);
    }
}
