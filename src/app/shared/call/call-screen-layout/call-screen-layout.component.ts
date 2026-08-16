import {Component, computed, effect, HostListener, inject, input, OnDestroy, output, signal} from '@angular/core';
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

    /**
     * Resolves a share's inbound statistics for the stats panel. Same reasoning as {@link nameOf}:
     * the two surfaces read them from two different services. Defaults to none.
     */
    inboundStatsOf = input<(share: CallScreenShare) => StreamStatsSnapshot | null>(() => null);

    protected readonly audio = trackAudioWait(this.participants, this.participantsWithAudio);
    /** The press that brought the app back to the front is not also a command - see the helper. */
    private readonly isActivationClick = trackActivationClick();
    private readonly shareWatch = inject(ShareWatchService);
    private readonly tileReport = inject(VoiceSubscriberReportService);
    private readonly callFocus = inject(CallFocusService);
    protected readonly rustMedia = inject(RustMediaService);

    participantContextMenu = output<CallScreenLayoutContextMenuEvent>();
    localAudioToggle = output<void>();
    remoteAudioToggle = output<string>();
    /**
     * The invite tile was pressed, for this channel.
     *
     * <p>Re-emitted rather than handled here: opening the picker needs the channel's roster, and
     * this component is shared with the DM call panel, which has neither a roster of guild members
     * nor a ring endpoint to point one at.</p>
     */
    inviteRequested = output<{guildId: string; channelId: string}>();
    /** Re-emitted from whichever tile opened or closed its stats panel. */
    statsInspect = output<CallScreenShare | null>();

    protected readonly maximizedId = signal<string | null>(null);

    /**
     * Whose stream {@link maximizedId} names, tracked so the maximise survives that id changing.
     *
     * <p>A share id is per-publication, not per-person: a sharer switching source ends one and opens
     * another seconds later. Without this, `displayedShares` filtered on an id nothing matched and
     * returned nothing at all - a completely empty stage, which is the worst of the failures this
     * work exists to remove.</p>
     */
    private readonly maximizedOwner = signal<string | null>(null);

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
        if (id !== null) {
            const exact = this.screenShares().filter(s => s.shareId === id);
            if (exact.length > 0) return exact;
            // The maximised share's id changed under us. That is a replacement, not a departure -
            // a publisher switching source opens a new track under a new id - and filtering on the
            // dead id leaves `displayedTiles` empty, which is a blank stage rather than a stream.
            // Following the same person is what the viewer meant by maximising them.
            const replacement = this.replacementFor(id);
            if (replacement) return [replacement];
            return exact;
        }

        const hidden = this.hiddenIds();
        const remote = this.remoteShares().filter(s => !hidden.has(s.shareId));
        return remote.length > 0 ? remote : this.screenShares().filter(s => !hidden.has(s.shareId));
    });


    /**
     * Everyone in the call, as a full seat on the stage.
     *
     * <p><b>Everyone, unconditionally.</b> This pool used to narrow to camera-on participants the
     * moment anything was being shared, so one person starting a stream rewrote the seating rules
     * for the whole channel: every camera-off face fell out of the grid and into a 32px avatar in
     * the strip below. In a two-person channel that reads as the call emptying out. A stream is one
     * more tile on the stage - see {@link displayedTiles} - and adding a tile is not a reason to
     * take anybody else's away.</p>
     *
     * <p>Not gated on `isCameraOn` in either direction. `app-call-participant-tile` draws a complete
     * seat for somebody with no camera - a centred avatar with the name pill - and draws the "camera
     * on, track still negotiating" state itself, so gating on the stream having arrived would only
     * mean the seat appearing a beat late and the whole grid reflowing under it the moment it did.
     * One participant, one seat, from the moment they join to the moment they leave.</p>
     *
     * <p>The `'camera'` tile kind is a misnomer for a pool this wide - it can hold a participant
     * with no camera at all - but it is the id space, not a claim about the tile's contents, and
     * both surfaces' share ids genuinely collide with user ids (see {@link cameraTile}).</p>
     */
    private readonly participantTiles = computed(() => this.participants().map(cameraTile));

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
        return [...shares, ...this.participantTiles()];
    });

    /**
     * Who is left for the participants strip: everyone whose face is not already on the stage.
     *
     * <p>A seat is a complete replacement for a strip entry - it carries the name, the muted glyph,
     * the speaking ring, the audio-wait badge and the context menu (see
     * call-participant-tile.component.html), so leaving the same person in the row below would be
     * showing them twice. Since {@link participantTiles} now seats everybody unconditionally, this
     * is empty in the ordinary case and the row disappears with it.</p>
     *
     * <p><b>Maximised is what this row is for.</b> {@link displayedTiles} is shares only while
     * something is maximised, so nobody is on stage as a person and everybody lands here - which is
     * also why the strip carries its own inline camera circle: in that one state it is the only
     * thing on screen showing a face, and rendering a static avatar instead would make turning your
     * camera on invisible the moment anyone maximised a stream.</p>
     *
     * <p>Nothing is lost on the way past this row now that it is usually empty. The per-person
     * stream mute it offers is also on `call-share-tile` itself, un-gated by hover, and the
     * audio-wait badge and context menu are both on the seat.</p>
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
     * Whether the self-card is the thing putting the local publish render on screen right now - see
     * RustMediaService.claimPreviewRender. Reads `localRender` rather than testing for a thumbnail,
     * because that picture is a decoded `MediaStream` on any host that can decode one and an
     * `<img>` only where that failed - see `CallScreenShare.localRender`. A browser session's
     * self-card shows its own `getDisplayMedia` track, which the projection marks false: Task 10's
     * idle pause has nothing to apply to there.
     */
    protected readonly claimingPreview = computed(() => {
        const self = this.selfCard();
        return !!self && !!self.localRender;
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
     * Whether `app-call-invite-card` fills the stage beside a lone tile - see that component's own
     * class doc for what it is and is not (layout only, no invite mechanic wired to it yet).
     *
     * <p>Gated on a SHARE-LESS stage holding exactly one tile, not on tile count alone. Tile count
     * alone is wrong: a maximised share is one tile by construction (see {@link displayedTiles} -
     * maximised is shares-only), and that is "something worth looking at", the exact case the card
     * exists to NOT compete with - a stream at half width with an invite card beside it is not the
     * empty channel this was written for. Requiring {@link displayedShares} to be empty is what
     * rules it out while still catching the real target: a lone participant with nothing shared.</p>
     *
     * <p>Deliberately reading {@link displayedTiles} rather than being folded into it - the card is
     * not a share and not a participant, so it must never reach {@link displayedShares} or the
     * watch-claim effect in the constructor, both of which are keyed off the tile list. The template
     * compensates for the card's extra slot at the render layer (forcing two columns) rather than
     * here, so {@link gridClass}'s own count and thresholds stay exactly what the existing specs pin
     * them to.</p>
     */
    /**
     * <p>Also requires a channel scope. The ring exists only inside a guild voice channel - a DM
     * call has no counterpart and no endpoint - so offering the tile there would draw the button
     * with nothing behind it, which is exactly the state this has just come out of.</p>
     */
    protected readonly showInviteCard = computed(() =>
        this.displayedShares().length === 0
        && this.displayedTiles().length === 1
        && this.watchScope()?.kind === 'channel');

    /** Re-emits the invite press with the channel it belongs to. Silent off a channel scope. */
    protected emitInviteRequest(): void {
        const scope = this.watchScope();
        if (scope?.kind !== 'channel') return;
        this.inviteRequested.emit({guildId: scope.guildId, channelId: scope.channelId});
    }

    /**
     * Whether to offer the persistent grid/focus control - see {@link toggleGridFocus}.
     *
     * <p>Needs something to focus <em>and</em> something to focus away from. A stage of nothing but
     * seats satisfies the second and not the first: there is no share for the press to maximise, so
     * the button would render and do nothing. The other direction is now only reachable with an
     * empty roster - a sharer has a seat of their own beside their stream (see
     * {@link participantTiles}), so a stream with anybody in the channel is already a two-tile
     * stage. Once maximised it is always offered, since going back to the grid is the whole reason
     * it exists for a caller that set `maximizedId` from outside.</p>
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
        //
        // Resuming shares are excluded from the pruning: they are still in `screenShares` by
        // construction, so a hide the viewer chose survives the gap rather than being undone by a
        // renegotiation they never saw.
        effect(() => {
            const liveIds = new Set(this.screenShares().map(s => s.shareId));
            this.hiddenIds.update(hidden => {
                if (hidden.size === 0) return hidden;
                const next = new Set([...hidden].filter(id => liveIds.has(id)));
                return next.size === hidden.size ? hidden : next;
            });
        });

        // Remembers whose stream is maximised, so {@link replacementFor} can follow them when the
        // share id changes underneath. Only ever written from a share that is actually present:
        // reading it off a dead id would clear the very thing it exists to remember.
        effect(() => {
            const id = this.maximizedId();
            if (id === null) {
                this.maximizedOwner.set(null);
                return;
            }
            const share = this.screenShares().find(s => s.shareId === id);
            if (share) this.maximizedOwner.set(share.userId);
        }, {allowSignalWrites: true});

        // Re-points the maximise at the replacement. `displayedShares` already falls through to it
        // so the picture never drops, but everything else keyed on the id - the tile's own
        // `maximized` binding, the toolbar toggle, the watch claim - would otherwise stay pointed
        // at a share that no longer exists.
        //
        // <p>And when nothing replaces it, the maximise is released rather than left pointing at a
        // share that ended. Maximised mode renders shares only (see {@link displayedTiles}), so a
        // dead id there is a stage with nothing on it at all - not even the people still in the
        // channel - which is what stopping your own share used to leave behind, with Escape as the
        // only way out. A share that is merely between tracks stays in `screenShares` as `'resuming'`
        // (see `screen-resume.ts`), so this only fires once the share is really gone.</p>
        effect(() => {
            const id = this.maximizedId();
            if (id === null) return;
            if (this.screenShares().some(s => s.shareId === id)) return;
            const replacement = this.replacementFor(id);
            this.maximizedId.set(replacement ? replacement.shareId : null);
        }, {allowSignalWrites: true});

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
        if (!scope) return;
        this.shareWatch.clear(scope);
        // The tiles retract their own measurements as they are destroyed, which would leave an empty
        // room behind holding a pending debounce. Dropping it here is what stops leaving a channel
        // from firing one last report against a room this client is no longer in.
        this.tileReport.clear(scope);
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

    /**
     * The share that took over from `deadId`, if the same person is still on the stage.
     *
     * <p>Keyed by owner rather than by anything on the id itself, because a replacement share has
     * nothing in common with the one it replaces - new session, new track, new id. What the viewer
     * chose when they maximised was a person's stream, and that is the thing worth following.</p>
     */
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
        this.maximizedId.update(id => id === shareId ? null : shareId);
    }

    /**
     * Escape gives the stage back, the same way it dismisses everything else on screen.
     *
     * <p>Bound on the document rather than on the stage, because maximising is reachable without
     * ever focusing anything inside it - a click on the picture, a notification action through
     * `CallFocusService`, the mini-player - so requiring focus here would leave the press dead in
     * exactly the cases somebody would reach for it.</p>
     *
     * <p>Ignored while a real fullscreen is open: the browser takes that press to exit fullscreen,
     * and acting on it too would undo two things from one keystroke and drop the viewer all the way
     * back to the grid from what they were watching.</p>
     */
    @HostListener('document:keydown.escape')
    protected onEscape(): void {
        if (document.fullscreenElement) return;
        this.maximizedId.set(null);
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
        // Same trap as the share tile's own press - see trackActivationClick. A pause now outlives
        // the window coming back, so this card is exactly what is under the cursor when the user
        // clicks the app to return to it, and that press means "the app", not "start decoding my
        // screen again". The deliberate second press does resume.
        if (this.isActivationClick()) return;
        if (previewPaused) {
            this.rustMedia.resumePreview();
            return;
        }
        this.maximizeSelf(shareId);
    }
}
