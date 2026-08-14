import {Component, computed, effect, inject, input, OnDestroy, output, signal} from '@angular/core';
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
import {trackAudioWait} from '../audio-wait';
import {CallAudioStatusComponent} from '../call-audio-status/call-audio-status.component';
import {CallParticipantTileComponent} from '../call-participant-tile/call-participant-tile.component';
import {CallShareTileComponent} from '../call-share-tile/call-share-tile.component';
import {CallTileActionComponent} from '../call-tile-action/call-tile-action.component';
import {ShareWatchService, WatchScope, scopeKey} from '../../../services/share-watch.service';
import {CallFocusService} from '../../../services/call-focus.service';
import {RustMediaService} from '../../../services/rust-media.service';

@Component({
    selector: 'app-call-screen-layout',
    imports: [
        TranslateModule,
        AppAvatarComponent,
        StreamSrcDirective,
        CallAudioStatusComponent,
        CallParticipantTileComponent,
        CallShareTileComponent,
        CallTileActionComponent,
    ],
    templateUrl: './call-screen-layout.component.html',
    host: {
        class: 'flex flex-col min-h-0'
    }
})
export class CallScreenLayoutComponent implements OnDestroy {
    screenShares = input.required<CallScreenShare[]>();
    participants = input.required<CallParticipant[]>();
    participantsWithAudio = input.required<Set<string>>();
    /**
     * Where these shares live, so watching them can be announced. Null disables the whole
     * viewer-count feature for this instance rather than guessing a scope.
     */
    watchScope = input<WatchScope | null>(null);
    /**
     * Resolves a viewer's user id to a display name for the popover on the viewer count.
     *
     * <p>Taken as an input rather than injected, because this component is shared between the DM
     * call panel and the guild voice channel, and the two draw names from completely different
     * places - guild members on one side, call participants on the other. Injecting either service
     * here would break the surface that does not use it. Defaults to echoing the id back, which is
     * only ever seen if a host forgets to wire this - not something a real caller should rely on.</p>
     */
    nameOf = input<(userId: string) => string>(id => id);

    protected readonly audio = trackAudioWait(this.participants, this.participantsWithAudio);
    private readonly shareWatch = inject(ShareWatchService);
    private readonly callFocus = inject(CallFocusService);
    protected readonly rustMedia = inject(RustMediaService);

    participantContextMenu = output<CallScreenLayoutContextMenuEvent>();
    localAudioToggle = output<void>();
    remoteAudioToggle = output<string>();

    protected readonly maximizedId = signal<string | null>(null);

    /**
     * Shares a viewer has explicitly dropped, by id - see {@link displayedShares}.
     *
     * <p>Only ever populated for remote shares (the tile gates its hide control to `!isLocal` - see
     * call-share-tile.component.html), and pruned in the constructor the moment a hidden share
     * disappears from {@link screenShares}, so a stream that stops and restarts under the same id
     * is not hidden the second time for a reason nobody chose.</p>
     */
    protected readonly hiddenIds = signal<ReadonlySet<string>>(new Set());

    private readonly remoteShares = computed(() => this.screenShares().filter(s => !s.isLocal));
    private readonly localShare = computed(() => this.screenShares().find(s => s.isLocal) ?? null);

    /**
     * The shares that get a full tile.
     *
     * <p>Your own is dropped from the grid as soon as anybody else is sharing. It is a low-rate
     * thumbnail of something already on your own screen, and at full tile size it read as a broken
     * stream while taking half the room from the streams you opened the channel to watch. It moves
     * to the self-card instead, which is where a monitor of your own output belongs.</p>
     *
     * <p>Hidden shares are dropped from the grid pool the same way - see {@link hiddenIds}. Not
     * applied while a share is maximised: {@link hideShare} always clears maximizedId for the share
     * it hides, so the maximised branch below never has to reconcile the two on its own.</p>
     */
    protected displayedShares = computed(() => {
        const id = this.maximizedId();
        if (id !== null) return this.screenShares().filter(s => s.shareId === id);

        const hidden = this.hiddenIds();
        const remote = this.remoteShares().filter(s => !hidden.has(s.shareId));
        return remote.length > 0 ? remote : this.screenShares().filter(s => !hidden.has(s.shareId));
    });

    /**
     * Everyone whose camera earns a full tile on the stage.
     *
     * <p>Gated on `isCameraOn` alone rather than on a stream having arrived, because
     * `app-call-participant-tile` draws the "camera on, track still negotiating" state itself. Waiting
     * for the track would mean the seat appearing a beat late and the whole grid reflowing under the
     * other tiles the moment it did.</p>
     */
    private readonly cameraTiles = computed(() => this.participants().filter(p => p.isCameraOn).map(cameraTile));

    /**
     * The one stage: screen shares and cameras as tiles in the same grid, at the same size.
     *
     * <p><b>Shares first.</b> A share is what somebody opened the channel to look at; a camera is who
     * they are looking at it with. Within each kind the caller's order is kept - see
     * {@link toggleGridFocus} for the one place that order is load-bearing.</p>
     *
     * <p><b>The share half is exactly {@link displayedShares}</b>, and that is not an implementation
     * detail to be optimised away. The watch claim is driven by `displayedShares()` (see the
     * constructor), so the set this grid renders and the set this client tells other people's
     * streamers it is watching are the same list read twice. Building the share tiles from anything
     * else - `screenShares()`, a re-derived filter - would let a streamer's viewer count drift away
     * from what is actually on screen.</p>
     *
     * <p><b>Maximise drops the cameras too.</b> Maximised means one tile, and a camera left beside it
     * would make "hide the other streams" a half-truth. Maximise stays a share-only idea in the other
     * direction as well: `maximizedId` holds a bare share id, not a {@link CallStageTile} id, because
     * the only controls that set it are the share tile's own maximise button, its double-click, and
     * `CallFocusService` - all three of which speak in share ids. `app-call-participant-tile` offers
     * fullscreen and picture-in-picture, which are a camera's equivalents, and no maximise.</p>
     */
    protected readonly displayedTiles = computed<CallStageTile[]>(() => {
        const shares = this.displayedShares().map(shareTile);
        if (this.maximizedId() !== null) return shares;
        return [...shares, ...this.cameraTiles()];
    });

    /**
     * Who is left for the participants strip: everyone whose face is not already on the stage.
     *
     * <p>A camera tile is a complete replacement for a strip entry - it carries the name, the muted
     * glyph, the speaking ring, the audio-wait badge and the context menu (see
     * call-participant-tile.component.html), so leaving the same person in the strip below would be
     * showing them twice.</p>
     *
     * <p>A share tile is <em>not</em>, and a sharer with their camera off therefore keeps their seat
     * here. It shows a screen, not a person: none of the audio-wait badge, the participant context
     * menu or the per-person stream mute exist on it, and dropping a sharer from the strip would take
     * all three away with nothing offering them instead.</p>
     */
    protected readonly stripParticipants = computed(() => {
        const onStage = new Set(this.displayedTiles()
            .filter(t => t.kind === 'camera')
            .map(t => t.participant.userId));
        return this.participants().filter(p => !onStage.has(p.userId));
    });

    /** The hidden shares still live in {@link screenShares}, for the restore-chip row - see the
     *  template. Deriving from `screenShares()` rather than trusting `hiddenIds` alone is what keeps
     *  a chip from naming a streamer who already left: a share that ends drops out of `screenShares`
     *  immediately, before the constructor's pruning effect even runs. */
    protected readonly hiddenShares = computed(() => {
        const hidden = this.hiddenIds();
        return hidden.size === 0 ? [] : this.screenShares().filter(s => hidden.has(s.shareId));
    });

    /** The local share when it is not in the grid - see {@link displayedShares}. */
    protected selfCard = computed(() => {
        const local = this.localShare();
        if (!local) return null;
        return this.displayedShares().some(s => s.shareId === local.shareId) ? null : local;
    });

    /**
     * Whether the self-card is the thing putting the local preview image on screen right now - see
     * RustMediaService.claimPreviewRender. Scoped to the `previewSrc` branch specifically: a
     * browser session's self-card shows a real `MediaStream` instead (see the class doc on
     * `CallScreenShare.previewSrc`), and Task 10's idle pause has nothing to apply to there.
     */
    protected readonly claimingPreview = computed(() => {
        const self = this.selfCard();
        return !!self && !self.stream && !!self.previewSrc;
    });

    /**
     * Columns for the count actually on screen. Two was the only answer before, so three streams
     * left a lone tile stranded on its own row at half width.
     *
     * <p>Counted over {@link displayedTiles} rather than the shares alone, and carrying a fourth
     * column, because the stage now holds cameras as well: a channel where five people have their
     * camera on beside two streams reaches counts the share-only thresholds never had to answer for,
     * and three columns of nine tiles is a wall of letterboxes.</p>
     */
    protected gridClass = computed(() => {
        const count = this.displayedTiles().length;
        if (count <= 1) return 'grid-cols-1';
        if (count <= 4) return 'grid-cols-2';
        if (count <= 9) return 'grid-cols-3';
        return 'grid-cols-4';
    });

    /**
     * Whether to offer the persistent grid/focus control - see {@link toggleGridFocus}.
     *
     * <p>Needs something to focus <em>and</em> something to focus away from. A stage of nothing but
     * cameras satisfies the second and not the first: there is no share for the press to maximise, so
     * the button would render and do nothing. Once maximised it is always offered, since going back
     * to the grid is the whole reason it exists for a caller that set `maximizedId` from outside.</p>
     */
    protected readonly canToggleFocus = computed(() =>
        this.maximizedId() !== null || (this.displayedTiles().length > 1 && this.displayedShares().length > 0));

    constructor() {
        // Driven by what is actually rendered, not by what is subscribed. Maximising one share
        // stops the others being displayed, and their streamers should stop counting this client -
        // which is the honest answer and one a subscribe-based signal could not give.
        effect(() => {
            const scope = this.watchScope();
            if (!scope) return;
            const watched = this.displayedShares()
                .filter(share => !share.isLocal)
                .map(share => share.shareId);
            this.shareWatch.setWatching(scope, watched);
        });

        // The change events are deltas, so a client that arrives after people started watching sees
        // an audience of nobody until the next one comes or goes.
        effect(() => {
            const scope = this.watchScope();
            if (scope) this.shareWatch.refresh(scope);
        });

        // The door an external caller uses to say "focus this share" - a notification action,
        // click-to-watch, the mini-player - without reaching into maximizedId, which stays private.
        // CallFocusService.consume() reads its own signal, so calling it here is what makes this
        // effect re-run on the next request; consuming it is what makes the request one-shot.
        effect(() => {
            const scope = this.watchScope();
            if (!scope) return;

            const target = this.callFocus.consume(scopeKey(scope));
            if (!target) return;

            const shareId = target.shareId
                ?? (target.userId ? this.getShareForUser(target.userId)?.shareId : undefined);
            if (shareId) this.maximizedId.set(shareId);
        }, {allowSignalWrites: true});

        // A hidden id is only meaningful while the share it names still exists. Without this, a
        // share that stops and restarts under the same id - the same user re-sharing to the same
        // slot - would come back hidden for a reason nobody chose this time.
        effect(() => {
            const liveIds = new Set(this.screenShares().map(s => s.shareId));
            this.hiddenIds.update(hidden => {
                if (hidden.size === 0) return hidden;
                const next = new Set([...hidden].filter(id => liveIds.has(id)));
                return next.size === hidden.size ? hidden : next;
            });
        });

        // Claims "somebody is rendering the preview" for Task 10's idle pause. onCleanup releases
        // it the moment claimingPreview goes false - the self-card going null because somebody
        // stopped sharing, or this component being destroyed outright - so the idle timer never
        // stays blocked by a claim nobody is actually looking at any more.
        effect(onCleanup => {
            if (!this.claimingPreview()) return;
            this.rustMedia.claimPreviewRender(this);
            onCleanup(() => this.rustMedia.releasePreviewRender(this));
        });
    }

    ngOnDestroy(): void {
        const scope = this.watchScope();
        if (scope) this.shareWatch.clear(scope);
    }

    /** How many people are watching this share, this client included. Zero renders nothing. */
    protected viewerCount(shareId: string): number {
        const scope = this.watchScope();
        return scope ? this.shareWatch.viewerCount(scope, shareId) : 0;
    }

    /** Who is watching this share, as display names - see {@link nameOf}. */
    protected viewerNames(shareId: string): string[] {
        const scope = this.watchScope();
        if (!scope) return [];
        return this.shareWatch.viewersOf(scope, shareId).map(this.nameOf());
    }

    protected getShareForUser(userId: string): CallScreenShare | undefined {
        return this.screenShares().find(s => s.userId === userId);
    }

    protected onShareAudioToggle(share: CallScreenShare): void {
        if (share.isLocal) this.localAudioToggle.emit();
        else this.remoteAudioToggle.emit(share.userId);
    }

    protected toggleMaximize(shareId: string): void {
        this.maximizedId.update(id => id === shareId ? null : shareId);
    }

    /**
     * Drops a share out of {@link displayedShares} - the watch-claim effect follows automatically,
     * since it is driven by what is displayed, not by what is subscribed.
     *
     * <p>If this share is the one currently maximised, unmaximising first is what keeps the grid
     * from rendering empty: maximised mode shows exactly one share, and hiding that one share with
     * nothing to fall back on would otherwise leave nothing on screen at all, even with other shares
     * available in the grid behind it.</p>
     */
    protected hideShare(shareId: string): void {
        if (this.maximizedId() === shareId) this.maximizedId.set(null);
        this.hiddenIds.update(ids => new Set(ids).add(shareId));
    }

    /** The inverse of {@link hideShare}, reached from a restore chip - see the template. */
    protected showShare(shareId: string): void {
        this.hiddenIds.update(ids => {
            if (!ids.has(shareId)) return ids;
            const next = new Set(ids);
            next.delete(shareId);
            return next;
        });
    }

    /**
     * The persistent grid/focus control, for when nobody has hovered a specific tile to reach its
     * own maximise button. Maximised clears back to the grid - the honest inverse of the state it is
     * in. In the grid, there is no single "the" share to focus without a specific tile having been
     * picked, so it focuses the first one displayed; a double-click on a particular tile (see
     * call-share-tile.component.html) is the precise way to choose which.
     *
     * <p>Still the first <em>share</em>, not the first tile, now that cameras share the grid: the
     * cameras sort after the shares (see {@link displayedTiles}) and there is no maximise for one
     * anyway, so `displayedShares()[0]` and "the first tile that could be focused" are the same
     * thing. Which of several shares that is remains array order rather than relevance - shares carry
     * no speaking or recency signal to rank by, so there is nothing better to pick.</p>
     */
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

    /**
     * The self-card's single click handler. While paused it resumes the preview instead of
     * maximising - maximising a frozen frame is not useful, and "any interaction with the preview
     * resumes it" is the whole point of the paused card being the button rather than growing a
     * second one nested inside it.
     */
    protected onSelfCardClick(shareId: string, previewPaused: boolean): void {
        if (previewPaused) {
            this.rustMedia.resumePreview();
            return;
        }
        this.maximizeSelf(shareId);
    }
}
