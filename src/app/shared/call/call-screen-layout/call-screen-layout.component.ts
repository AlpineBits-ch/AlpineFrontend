import {Component, computed, effect, inject, input, OnDestroy, output, signal} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {CallParticipant, CallScreenLayoutContextMenuEvent, CallScreenShare} from '../call.types';
import {AppAvatarComponent} from '../../../components/avatar/avatar.component';
import {StreamSrcDirective} from '../../../directives/stream-src.directive';
import {trackAudioWait} from '../audio-wait';
import {CallAudioStatusComponent} from '../call-audio-status/call-audio-status.component';
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

    /** Columns for the count actually on screen. Two was the only answer before, so three streams
     *  left a lone tile stranded on its own row at half width. */
    protected gridClass = computed(() => {
        const count = this.displayedShares().length;
        if (count <= 1) return 'grid-cols-1';
        if (count <= 4) return 'grid-cols-2';
        return 'grid-cols-3';
    });

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
