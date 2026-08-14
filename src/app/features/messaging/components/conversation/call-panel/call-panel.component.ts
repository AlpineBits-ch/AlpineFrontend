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
import {scopeKey, WatchScope} from '../../../../../services/share-watch.service';
import {CallStagePresenceService} from '../../../../../services/call-stage-presence.service';
import {dmScreenShares} from '../../../../../shared/call/call-projection';
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
    /** The dragged (or default) strip height. Kept untouched by full view, so restoring out of it
     *  lands back where the user left it rather than snapping to DEFAULT_HEIGHT. */
    protected panelHeight = signal(DEFAULT_HEIGHT);
    protected isResizing = signal(false);
    /** A signal, not a field: it is bound into the status bar, which is OnPush. */
    protected duration = signal('00:00');
    /**
     * Whether the panel fills its container instead of being a clamped, draggable strip.
     *
     * Deliberately not `protected`: `ConversationComponent` reads it through `viewChild()` to
     * collapse the message list while a call is full-view, and to un-collapse it - with no reset
     * code anywhere - the moment this component is torn down, because the panel only exists behind
     * `@if (activeCall())`. A fresh call gets a fresh `CallPanelComponent` instance and this signal
     * starts `false` again, so full view can never leak from one call into the next.
     */
    readonly isFullView = signal(false);
    private callSession = inject(CallSessionService);
    private callWebRtc = inject(CallWebRtcService);
    private translate = inject(TranslateService);
    protected callParticipants = computed((): CallParticipant[] => this.session()?.participants ?? []);
    /** See {@link dmScreenShares} - the mapping is shared with the app-level mini-player. */
    protected callScreenShares = computed((): CallScreenShare[] => dmScreenShares(
        this.callSession, this.callWebRtc, this.rustMedia, this.session()?.screenShares ?? [],
    ));
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


    private resizeStartY = 0;
    private resizeStartHeight = 0;
    private presence = inject(CallStagePresenceService);

    constructor() {
        // Tells the app-level mini-player that this call's full stage is on screen, so it can stand
        // down - see CallStagePresenceService. Keyed by the call, so leaving the conversation (which
        // tears this panel down without ending the call) hands the picture over to the mini-player.
        this.presence.track(computed(() => {
            const scope = this.watchScope();
            return scope ? scopeKey(scope) : null;
        }));
    }

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
        // The handle is removed from the template while full-view is on (nothing for it to resize),
        // but a component-level guard as well means that stays true even if a stray mousedown ever
        // reaches this handler before Angular has finished tearing the element down.
        if (this.isFullView()) return;
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

    /**
     * Full view means the panel fills the whole content area rather than being clamped to
     * MAX_HEIGHT - `panelHeight` is never touched here, so toggling back off restores exactly the
     * height the user last dragged to, not DEFAULT_HEIGHT.
     */
    protected toggleMaximize(): void {
        this.isFullView.update(v => !v);
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
        // CallParticipant carries no isScreenSharing flag on the DM path (unlike the guild
        // roster), so sharing is read off the session's own screen-share list instead. Left
        // undefined when not sharing - that is what the menu template reads to decide whether the
        // second slider has anything to control.
        const isSharing = (this.session()?.screenShares ?? []).some(sh => sh.userId === p.userId);
        const streamVolume = isSharing ? Math.round(this.callWebRtc.getScreenVolume(p.userId) * 100) : undefined;
        const x = Math.min(event.clientX, window.innerWidth - 236);
        const y = Math.min(event.clientY, window.innerHeight - 200);
        this.participantMenu.set({x: Math.max(0, x), y: Math.max(0, y), participant: p, volume, streamVolume});
    }

    protected onVolumeChange(value: number): void {
        const menu = this.participantMenu();
        if (!menu) return;
        this.participantMenu.set({...menu, volume: value});
        this.callWebRtc.setUserVolume(menu.participant.userId, value / 100);
    }

    protected onStreamVolumeChange(value: number): void {
        const menu = this.participantMenu();
        if (!menu) return;
        this.participantMenu.set({...menu, streamVolume: value});
        this.callWebRtc.setScreenVolume(menu.participant.userId, value / 100);
    }
}
