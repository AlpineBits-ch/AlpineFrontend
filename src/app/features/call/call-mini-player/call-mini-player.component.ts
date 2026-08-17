import {
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    effect,
    ElementRef,
    HostListener,
    inject,
    signal,
    untracked,
    viewChild,
} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {VoiceChannelService} from '../../../services/voice-channel.service';
import {CallSessionService} from '../../../services/call-session.service';
import {CallWebRtcService} from '../../../services/call-webrtc.service';
import {RustMediaService} from '../../../services/rust-media.service';
import {GuildService} from '../../../services/guild.service';
import {ConversationStore} from '../../../stores/conversation.store';
import {NavigationService} from '../../main-page/navigation.service';
import {CallStagePresenceService} from '../../../services/call-stage-presence.service';
import {CallMiniPlayerService} from '../../../services/call-mini-player.service';
import {CallFocusService} from '../../../services/call-focus.service';
import {scopeKey, ShareWatchService, WatchScope} from '../../../services/share-watch.service';
import {CallParticipant, CallScreenShare} from '../../../shared/call/call.types';
import {guildCallParticipants, guildScreenShares, dmScreenShares} from '../../../shared/call/call-projection';
import {CallLiveBadgeComponent} from '../../../shared/call/call-live-badge/call-live-badge.component';
import {CallTileActionComponent} from '../../../shared/call/call-tile-action/call-tile-action.component';
import {StreamSrcDirective} from '../../../directives/stream-src.directive';

/** How many faces the participant miniature shows before it stops. Four fits a 2x2 at this size. */
const MINIATURE_LIMIT = 4;

/** The picture, kept while you go and read something else. */
@Component({
    selector: 'app-call-mini-player',
    imports: [TranslateModule, CallLiveBadgeComponent, CallTileActionComponent, StreamSrcDirective],
    templateUrl: './call-mini-player.component.html',
    styleUrl: './call-mini-player.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CallMiniPlayerComponent {
    private readonly voiceSvc = inject(VoiceChannelService);
    private readonly callSession = inject(CallSessionService);
    private readonly callWebRtc = inject(CallWebRtcService);
    private readonly rustMedia = inject(RustMediaService);
    private readonly guildService = inject(GuildService);
    private readonly conversationStore = inject(ConversationStore);
    private readonly navService = inject(NavigationService);
    private readonly presence = inject(CallStagePresenceService);
    private readonly callFocus = inject(CallFocusService);
    private readonly shareWatch = inject(ShareWatchService);
    private readonly miniPlayer = inject(CallMiniPlayerService);

    private readonly tile = viewChild<ElementRef<HTMLElement>>('tile');

    /**
     * Guild voice first, exactly as the sidebar voice bar decides it: only one surface is ever live
     * at a time, and checking one of them first means the two session shapes never have to be
     * reconciled into a single type - everything below just asks "which one" and branches once.
     */
    protected readonly isGuildVoice = computed(() => this.voiceSvc.isInVoice());

    /** Where the live session's shares live, or null when there is no session at all. */
    private readonly scope = computed((): WatchScope | null => {
        if (this.isGuildVoice()) {
            const channelId = this.voiceSvc.joinedChannelId();
            const guildId = this.voiceSvc.joinedGuildId();
            return channelId && guildId ? {kind: 'channel', guildId, channelId} : null;
        }
        const callId = this.callSession.session()?.callId;
        return callId ? {kind: 'call', callId} : null;
    });

    private readonly stageKey = computed(() => {
        const scope = this.scope();
        return scope ? scopeKey(scope) : null;
    });

    /** A session is running, its own stage is not on screen, and the user has not sent the tile away. */
    protected readonly visible = computed(() => this.stageKey() !== null
        && !this.presence.isMounted(this.stageKey())
        && this.miniPlayer.dismissedKey() !== this.stageKey());

    private readonly guildRoster = computed(() => {
        const channelId = this.voiceSvc.joinedChannelId();
        return channelId ? this.voiceSvc.channelParticipants().get(channelId) ?? [] : [];
    });

    /** The same projections the stages render from - see `call-projection.ts`. */
    private readonly shares = computed((): CallScreenShare[] => this.isGuildVoice()
        ? guildScreenShares(this.voiceSvc, this.rustMedia, this.guildRoster())
        : dmScreenShares(
            this.callSession, this.callWebRtc, this.rustMedia,
            this.callSession.session()?.screenShares ?? [],
        ));

    /** The one stream this shows. */
    protected readonly focusedShare = computed(() => this.shares().find(share => !share.isLocal) ?? null);

    /**
     * Whether this tile is the thing putting the local preview image on screen right now - see
     * RustMediaService.claimPreviewRender for Task 10's idle pause.
     */
    private readonly showingLocalPreview = computed(() => {
        const share = this.focusedShare();
        return this.visible() && !!share && share.isLocal && !!share.localRender;
    });

    private readonly participants = computed((): CallParticipant[] => this.isGuildVoice()
        ? guildCallParticipants(this.voiceSvc, this.guildRoster())
        : this.callSession.session()?.participants ?? []);

    /** Faces to show when nobody is sharing. Capped - this is a thumbnail, not a roster. */
    protected readonly miniature = computed(() => this.participants().slice(0, MINIATURE_LIMIT));
    protected readonly overflowCount = computed(() =>
        Math.max(0, this.participants().length - MINIATURE_LIMIT));

    /** Whose stream this is, or where the call is, when there is no stream. */
    protected readonly title = computed(() => {
        const share = this.focusedShare();
        if (share) return share.displayName;
        if (this.isGuildVoice()) return this.voiceSvc.joinedChannelName() ?? '';
        return this.participants().filter(p => !p.isLocal).map(p => p.displayName).join(', ');
    });

    protected readonly isMuted = computed(() => this.isGuildVoice()
        ? this.voiceSvc.localState().isMuted
        : (this.callSession.session()?.local.isMuted ?? false));
    protected readonly isDeafened = computed(() => this.isGuildVoice()
        ? this.voiceSvc.localState().isDeafened
        : (this.callSession.session()?.local.isDeafened ?? false));

    /**
     * `VOICE_BAR.DISCONNECT` reads "Disconnect from voice channel" in German and French, which is
     * wrong for a DM call that has no channel - the same split the sidebar voice bar makes.
     */
    protected readonly disconnectLabelKey = computed(() =>
        this.isGuildVoice() ? 'VOICE_BAR.DISCONNECT' : 'CALL.DISCONNECT');

    /**
     * Where the tile sits, for this session only - nothing is persisted, because a floating tile
     * that reappears weeks later in a corner the user has forgotten choosing is a bug report.
     * Null means "wherever the default corner is", which is a CSS anchor rather than a coordinate,
     * so the tile does not need the viewport size before it has ever been dragged.
     */
    protected readonly position = signal<{x: number; y: number} | null>(null);

    /** Cursor-to-corner offset for the drag in progress; null when not dragging. */
    private dragOffset: {x: number; y: number} | null = null;

    /** The claim currently announced to the server, so it can be released against the right scope. */
    private claimed: WatchScope | null = null;

    constructor() {
        // Watch claims are driven by what is rendered (see ShareWatchService), and this renders a
        // stream from outside either stage. Without this, the moment anybody navigated away from a
        // call the streamer's viewer count would drop while the audience was still watching - which
        // is the whole point of requirement 5.
        effect(() => {
            const scope = this.visible() ? this.scope() : null;
            const shareId = this.visible() ? this.focusedShare()?.shareId ?? null : null;
            untracked(() => this.applyClaim(scope, shareId));
        });

        // A new session gets a fresh tile. This component is mounted once for the whole app and
        // never torn down, so without this both the position and, worse, a dismissal would leak
        // from one call into the next and leave the next call with no tile.
        effect(() => {
            this.stageKey();
            untracked(() => {
                this.position.set(null);
                this.miniPlayer.restore();
            });
        });

        inject(DestroyRef).onDestroy(() => {
            this.applyClaim(null, null);
            this.onDragEnd();
        });

        // Task 10's preview-render claim - see showingLocalPreview's doc comment for why this never
        // actually fires today. onCleanup releases it exactly as the watch claim above is released,
        // so nothing here can leak past this tile going invisible, dismissed, or destroyed.
        effect(onCleanup => {
            if (!this.showingLocalPreview()) return;
            this.rustMedia.claimPreviewRender(this);
            onCleanup(() => this.rustMedia.releasePreviewRender(this));
        });
    }

    // ── Watch claim ────────────────────────────────────────────────────────────

    /** Announces (or drops) this tile's single claim. */
    private applyClaim(scope: WatchScope | null, shareId: string | null): void {
        const desired = scope && shareId ? scope : null;
        const previous = this.claimed;

        if (previous && (!desired || scopeKey(previous) !== scopeKey(desired))) {
            this.claimed = null;
            if (!this.presence.isMounted(scopeKey(previous))) this.shareWatch.setWatching(previous, []);
        }

        if (!desired || !shareId) return;
        this.claimed = desired;
        this.shareWatch.setWatching(desired, [shareId]);
    }

    // ── Drag ───────────────────────────────────────────────────────────────────

    /**
     * Grabs the tile by its header. The first drag is also what turns the CSS-anchored default
     * corner into real coordinates, which is why it seeds `position` from the measured rectangle
     * rather than from the cursor.
     */
    protected onDragStart(event: MouseEvent): void {
        if (event.button !== 0) return;
        // The close button sits in the header, and `CallTileActionComponent` only stops the *click*
        // from reaching the tile beneath it. Without this, pressing close would also begin a drag
        // and, on the way out, plant the tile at coordinates the user never chose.
        if ((event.target as HTMLElement).closest('button')) return;

        const rect = this.tile()?.nativeElement.getBoundingClientRect();
        if (!rect) return;

        this.dragOffset = {x: event.clientX - rect.left, y: event.clientY - rect.top};
        this.position.set(this.clamp(rect.left, rect.top));
        document.addEventListener('mousemove', this.onDragMove);
        document.addEventListener('mouseup', this.onDragEnd);
        event.preventDefault();
    }

    private readonly onDragMove = (event: MouseEvent): void => {
        const offset = this.dragOffset;
        if (!offset) return;
        this.position.set(this.clamp(event.clientX - offset.x, event.clientY - offset.y));
    };

    private readonly onDragEnd = (): void => {
        this.dragOffset = null;
        document.removeEventListener('mousemove', this.onDragMove);
        document.removeEventListener('mouseup', this.onDragEnd);
    };

    /**
     * A window that shrinks under a tile parked at the right or bottom edge would otherwise leave it
     * half off screen, or entirely off it - and there is no scrollbar to bring a `position: fixed`
     * element back.
     */
    @HostListener('window:resize')
    protected onWindowResize(): void {
        const current = this.position();
        if (current) this.position.set(this.clamp(current.x, current.y));
    }

    /** Keeps the whole tile inside the viewport. `max(0, …)` last, for a viewport smaller than it. */
    private clamp(x: number, y: number): {x: number; y: number} {
        const el = this.tile()?.nativeElement;
        const width = el?.offsetWidth ?? 0;
        const height = el?.offsetHeight ?? 0;
        return {
            x: Math.max(0, Math.min(x, window.innerWidth - width)),
            y: Math.max(0, Math.min(y, window.innerHeight - height)),
        };
    }

    // ── Actions ────────────────────────────────────────────────────────────────

    /** Mute and deafen. Engaged reads as danger, the same way the in-call controls bar reads it. */
    protected toggleClass(active: boolean): string {
        const base = 'call-focusable flex size-7 shrink-0 cursor-pointer items-center justify-center'
            + ' rounded-lg border-0 transition-colors';
        return active
            ? `${base} bg-offline/15 text-offline hover:bg-offline/25`
            : `${base} bg-white/[0.06] text-white/70 hover:bg-white/[0.12]`;
    }

    /**
     * Sends the tile away for this session. The way back is the sidebar voice bar, which is already
     * the always-present call indicator - see `CallMiniPlayerService` for why the state does not
     * live in this component.
     */
    protected dismiss(): void {
        this.miniPlayer.dismiss(this.stageKey());
    }

    protected toggleMute(): void {
        if (this.isGuildVoice()) this.voiceSvc.toggleMute();
        else this.callSession.toggleMute();
    }

    protected toggleDeafen(): void {
        if (this.isGuildVoice()) this.voiceSvc.toggleDeafen();
        else this.callSession.toggleDeafen();
    }

    protected disconnect(): void {
        if (this.isGuildVoice()) void this.voiceSvc.leaveChannel();
        else this.callSession.end();
    }

    /** Back to the stage, on the stream that was being watched here. */
    protected returnToCall(): void {
        const key = this.stageKey();
        const share = this.focusedShare();
        if (key && share) this.callFocus.request(key, {shareId: share.shareId});

        if (this.isGuildVoice()) this.navigateToChannel();
        else this.navigateToConversation();
    }

    /**
     * Unlike the sidebar voice bar, this resolves the guild through `GuildService.guilds()` rather
     * than only through the current workspace. The tile is at its most useful precisely when the
     * user has wandered off - including into another server - and a "return to call" button that
     * silently does nothing from there is worse than no button.
     */
    private navigateToChannel(): void {
        const channelId = this.voiceSvc.joinedChannelId();
        const guildId = this.voiceSvc.joinedGuildId();
        if (!channelId || !guildId) return;

        const workspace = this.navService.workspace();
        const guild = workspace.type === 'server' && workspace.guild.id === guildId
            ? workspace.guild
            : this.guildService.guilds().find(g => g.id === guildId);
        if (!guild) return;

        // A no-op when that guild is already the workspace - see NavigationService.selectServer.
        this.navService.selectServer(guild);
        const channel = guild.channels.find(c => c.id === channelId);
        if (channel) this.navService.openChannel(channel);
    }

    private navigateToConversation(): void {
        const conversationId = this.callSession.session()?.conversationId;
        if (!conversationId) return;
        const conversation = this.conversationStore.entities().find(c => c.id === conversationId);
        if (conversation) this.navService.openConversation(conversation);
    }
}
