import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    HostListener,
    inject,
    input,
    OnDestroy,
    output,
    signal,
} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {
    CallParticipant,
    CallScreenLayoutContextMenuEvent,
    CallScreenShare,
    CallStageTile,
    cameraTile,
    shareTile,
} from '../call.types';
import {AppAvatarComponent} from '../../../components/avatar/avatar.component';
import {StreamSrcDirective} from '../../../directives/stream-src.directive';
import {trackActivationClick} from '../activation-click';
import {trackAudioWait} from '../audio-wait';
import {CallAudioStatusComponent} from '../call-audio-status/call-audio-status.component';
import {CallInviteCardComponent} from '../call-invite-card/call-invite-card.component';
import {CallParticipantTileComponent} from '../call-participant-tile/call-participant-tile.component';
import {CallShareTileComponent} from '../call-share-tile/call-share-tile.component';
import {CallTileActionComponent} from '../call-tile-action/call-tile-action.component';
import {ShareWatchService, WatchScope, scopeKey} from '../../../services/share-watch.service';
import {CallFocusService} from '../../../services/call-focus.service';
import {RustMediaService} from '../../../services/rust-media.service';
import {VoiceSubscriberReportService} from '../../../services/voice-subscriber-report.service';
import {StreamStatsSnapshot} from '../stream-stats';

@Component({
    selector: 'app-call-screen-layout',
    imports: [
        TranslateModule,
        AppAvatarComponent,
        StreamSrcDirective,
        CallAudioStatusComponent,
        CallInviteCardComponent,
        CallParticipantTileComponent,
        CallShareTileComponent,
        CallTileActionComponent,
    ],
    templateUrl: './call-screen-layout.component.html',
    host: {
        class: 'flex flex-col min-h-0',
    },
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CallScreenLayoutComponent implements OnDestroy {
    readonly screenShares = input.required<CallScreenShare[]>();
    readonly participants = input.required<CallParticipant[]>();
    readonly participantsWithAudio = input.required<Set<string>>();
    /** Where these shares live, so watching them can be announced. Null disables viewer counts. */
    readonly watchScope = input<WatchScope | null>(null);
    /** Resolves a viewer's user id to a display name for the popover on the viewer count. */
    readonly nameOf = input<(userId: string) => string>(id => id);

    /** Resolves a share's inbound statistics for the stats panel. Defaults to none. */
    readonly inboundStatsOf = input<(share: CallScreenShare) => StreamStatsSnapshot | null>(() => null);

    protected readonly audio = trackAudioWait(this.participants, this.participantsWithAudio);
    /** The press that brought the app back to the front is not also a command. */
    private readonly isActivationClick = trackActivationClick();
    private readonly shareWatch = inject(ShareWatchService);
    private readonly tileReport = inject(VoiceSubscriberReportService);
    private readonly callFocus = inject(CallFocusService);
    protected readonly rustMedia = inject(RustMediaService);

    participantContextMenu = output<CallScreenLayoutContextMenuEvent>();
    localAudioToggle = output<void>();
    remoteAudioToggle = output<string>();
    /** The invite tile was pressed, for this channel. */
    inviteRequested = output<{guildId: string; channelId: string}>();
    /** Re-emitted from whichever tile opened or closed its stats panel. */
    statsInspect = output<CallScreenShare | null>();

    protected readonly maximizedId = signal<string | null>(null);

    /** Whose stream {@link maximizedId} names, tracked so the maximise survives that id changing. */
    private readonly maximizedOwner = signal<string | null>(null);

    /** Shares a viewer has explicitly dropped, by id. Remote shares only. */
    protected readonly hiddenIds = signal<ReadonlySet<string>>(new Set());

    private readonly remoteShares = computed(() => this.screenShares().filter(s => !s.isLocal));
    private readonly localShare = computed(() => this.screenShares().find(s => s.isLocal) ?? null);

    /** The shares that get a full tile. Your own drops out of the grid as soon as anybody else shares. */
    protected readonly displayedShares = computed(() => {
        const id = this.maximizedId();
        if (id !== null) {
            const exact = this.screenShares().filter(s => s.shareId === id);
            if (exact.length > 0) return exact;
            // The maximised share's id changed under us: a replacement, not a departure.
            const replacement = this.replacementFor(id);
            if (replacement) return [replacement];
            return exact;
        }

        const hidden = this.hiddenIds();
        const remote = this.remoteShares().filter(s => !hidden.has(s.shareId));
        return remote.length > 0 ? remote : this.screenShares().filter(s => !hidden.has(s.shareId));
    });

    /** Everyone in the call, as a full seat on the stage. One participant, one seat, unconditionally. */
    private readonly participantTiles = computed(() => this.participants().map(cameraTile));

    /**
     * The one stage: screen shares first, then cameras, in the same grid at the same size.
     * The share half must stay exactly {@link displayedShares}, which is what the watch claim reads.
     */
    protected readonly displayedTiles = computed<CallStageTile[]>(() => {
        const shares = this.displayedShares().map(shareTile);
        if (this.maximizedId() !== null) return shares;
        return [...shares, ...this.participantTiles()];
    });

    /** Who is left for the participants strip: everyone whose face is not already on the stage. */
    protected readonly stripParticipants = computed(() => {
        const onStage = new Set(
            this.displayedTiles()
                .filter(t => t.kind === 'camera')
                .map(t => t.participant.userId),
        );
        return this.participants().filter(p => !onStage.has(p.userId));
    });

    /** The hidden shares that are still live, for the restore-chip row. */
    protected readonly hiddenShares = computed(() => {
        const hidden = this.hiddenIds();
        return hidden.size === 0 ? [] : this.screenShares().filter(s => hidden.has(s.shareId));
    });

    /** The local share when it is not in the grid. */
    protected readonly selfCard = computed(() => {
        const local = this.localShare();
        if (!local) return null;
        return this.displayedShares().some(s => s.shareId === local.shareId) ? null : local;
    });

    /** Whether the self-card is the thing putting the local publish render on screen right now. */
    protected readonly claimingPreview = computed(() => {
        const self = this.selfCard();
        return !!self && !!self.localRender;
    });

    /** Columns for the count actually on screen, counted over {@link displayedTiles}. */
    protected readonly gridClass = computed(() => {
        const count = this.displayedTiles().length;
        if (count <= 1) return 'grid-cols-1';
        if (count <= 4) return 'grid-cols-2';
        if (count <= 9) return 'grid-cols-3';
        return 'grid-cols-4';
    });

    /**
     * How the stage grid is sized. Maximised is one `1fr` row the tile fills, so the picture fits the
     * box it was given: `auto-rows-min` sizes a row from `aspect-video`, which at full stage width is
     * taller than the space left by the strip and the controls, and the stage scrolls.
     * Two columns are forced while the invite card is showing, because gridClass() counts
     * {@link displayedTiles} alone.
     */
    protected readonly stageClass = computed(() => {
        if (this.maximizedId() !== null) return 'grid-cols-1 grid-rows-1 overflow-hidden';
        const cols = this.showInviteCard() ? 'grid-cols-2' : this.gridClass();
        return `auto-rows-min overflow-y-auto thin-scrollbar ${cols}`;
    });

    /**
     * Whether `app-call-invite-card` fills the stage beside a lone tile: a share-less stage of one
     * tile, in a channel scope. The card must never reach {@link displayedShares} or the watch claim.
     */
    protected readonly showInviteCard = computed(
        () =>
            this.displayedShares().length === 0 &&
            this.displayedTiles().length === 1 &&
            this.watchScope()?.kind === 'channel',
    );

    /** Re-emits the invite press with the channel it belongs to. Silent off a channel scope. */
    protected emitInviteRequest(): void {
        const scope = this.watchScope();
        if (scope?.kind !== 'channel') return;
        this.inviteRequested.emit({guildId: scope.guildId, channelId: scope.channelId});
    }

    /** Whether to offer the persistent grid/focus control. Needs a share to focus and a tile to focus away from. */
    protected readonly canToggleFocus = computed(
        () =>
            this.maximizedId() !== null ||
            (this.displayedTiles().length > 1 && this.displayedShares().length > 0),
    );

    constructor() {
        // The watch claim is driven by what is actually rendered, not by what is subscribed.
        effect(() => {
            const scope = this.watchScope();
            if (!scope) return;
            const watched = this.displayedShares()
                .filter(share => !share.isLocal)
                .map(share => share.shareId);
            this.shareWatch.setWatching(scope, watched);
        });

        // The change events are deltas, so a late-arriving client needs one full refresh.
        effect(() => {
            const scope = this.watchScope();
            if (scope) this.shareWatch.refresh(scope);
        });

        // The door an external caller uses to say "focus this share". consume() must be called here:
        // reading its signal is what re-runs this effect, and consuming is what makes it one-shot.
        effect(
            () => {
                const scope = this.watchScope();
                if (!scope) return;

                const target = this.callFocus.consume(scopeKey(scope));
                if (!target) return;

                const shareId =
                    target.shareId ??
                    (target.userId ? this.getShareForUser(target.userId)?.shareId : undefined);
                if (shareId) this.maximizedId.set(shareId);
            },
            {allowSignalWrites: true},
        );

        // A hidden id is only meaningful while the share it names still exists.
        effect(() => {
            const liveIds = new Set(this.screenShares().map(s => s.shareId));
            this.hiddenIds.update(hidden => {
                if (hidden.size === 0) return hidden;
                const next = new Set([...hidden].filter(id => liveIds.has(id)));
                return next.size === hidden.size ? hidden : next;
            });
        });

        // Remembers whose stream is maximised, so replacementFor can follow them when the share id
        // changes underneath. Only ever written from a share that is actually present.
        effect(
            () => {
                const id = this.maximizedId();
                if (id === null) {
                    this.maximizedOwner.set(null);
                    return;
                }
                const share = this.screenShares().find(s => s.shareId === id);
                if (share) this.maximizedOwner.set(share.userId);
            },
            {allowSignalWrites: true},
        );

        // Re-points the maximise at the replacement, or releases it when nothing replaced the share.
        effect(
            () => {
                const id = this.maximizedId();
                if (id === null) return;
                if (this.screenShares().some(s => s.shareId === id)) return;
                const replacement = this.replacementFor(id);
                this.maximizedId.set(replacement ? replacement.shareId : null);
            },
            {allowSignalWrites: true},
        );

        // Claims "somebody is rendering the preview" for the idle pause. Every way claimingPreview
        // can go false must release, or the idle timer stays blocked.
        effect(onCleanup => {
            if (!this.claimingPreview()) return;
            this.rustMedia.claimPreviewRender(this);
            onCleanup(() => this.rustMedia.releasePreviewRender(this));
        });
    }

    ngOnDestroy(): void {
        const scope = this.watchScope();
        if (!scope) return;
        this.shareWatch.clear(scope);
        // Drop the pending debounce, or leaving a channel fires one last report against it.
        this.tileReport.clear(scope);
    }

    /** How many people are watching this share, this client included. Zero renders nothing. */
    protected viewerCount(shareId: string): number {
        const scope = this.watchScope();
        return scope ? this.shareWatch.viewerCount(scope, shareId) : 0;
    }

    /** Who is watching this share, as display names. */
    protected viewerNames(shareId: string): string[] {
        const scope = this.watchScope();
        if (!scope) return [];
        return this.shareWatch.viewersOf(scope, shareId).map(this.nameOf());
    }

    /** The share that took over from `deadId`, if the same person is still on the stage. */
    private replacementFor(deadId: string): CallScreenShare | undefined {
        const owner = this.maximizedOwner();
        if (owner === null) return undefined;
        return this.screenShares().find(s => s.userId === owner && s.shareId !== deadId);
    }

    protected getShareForUser(userId: string): CallScreenShare | undefined {
        return this.screenShares().find(s => s.userId === userId);
    }

    protected onShareAudioToggle(share: CallScreenShare): void {
        if (share.isLocal) this.localAudioToggle.emit();
        else this.remoteAudioToggle.emit(share.userId);
    }

    protected toggleMaximize(shareId: string): void {
        this.maximizedId.update(id => (id === shareId ? null : shareId));
    }

    /** Escape gives the stage back. Ignored while a real fullscreen is open: the browser takes that press. */
    @HostListener('document:keydown.escape')
    protected onEscape(): void {
        if (document.fullscreenElement) return;
        this.maximizedId.set(null);
    }

    /** Drops a share out of {@link displayedShares}. Must unmaximise it first, or the stage renders empty. */
    protected hideShare(shareId: string): void {
        if (this.maximizedId() === shareId) this.maximizedId.set(null);
        this.hiddenIds.update(ids => new Set(ids).add(shareId));
    }

    /** The inverse of {@link hideShare}, reached from a restore chip. */
    protected showShare(shareId: string): void {
        this.hiddenIds.update(ids => {
            if (!ids.has(shareId)) return ids;
            const next = new Set(ids);
            next.delete(shareId);
            return next;
        });
    }

    /** The persistent grid/focus control: maximised clears back to the grid, the grid focuses the first share. */
    protected toggleGridFocus(): void {
        if (this.maximizedId() !== null) {
            this.maximizedId.set(null);
            return;
        }
        const first = this.displayedShares()[0];
        if (first) this.maximizedId.set(first.shareId);
    }

    /** Promotes the self-card into the grid, so a streamer can check their own output. */
    protected maximizeSelf(shareId: string): void {
        this.maximizedId.set(shareId);
    }

    /** The self-card's single click handler. While paused it resumes the preview instead of maximising. */
    protected onSelfCardClick(shareId: string, previewPaused: boolean): void {
        if (this.isActivationClick()) return;
        if (previewPaused) {
            this.rustMedia.resumePreview();
            return;
        }
        this.maximizeSelf(shareId);
    }
}
