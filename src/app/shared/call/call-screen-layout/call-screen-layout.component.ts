import {Component, computed, effect, inject, input, OnDestroy, output, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {CallParticipant, CallScreenLayoutContextMenuEvent, CallScreenShare} from '../call.types';
import {AppAvatarComponent} from '../../../components/avatar/avatar.component';
import {StreamSrcDirective} from '../../../directives/stream-src.directive';
import {trackAudioWait} from '../audio-wait';
import {CallAudioStatusComponent} from '../call-audio-status/call-audio-status.component';
import {ShareWatchService, WatchScope} from '../../../services/share-watch.service';

@Component({
    selector: 'app-call-screen-layout',
    imports: [NgClass, AppAvatarComponent, StreamSrcDirective, CallAudioStatusComponent],
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

    protected readonly audio = trackAudioWait(this.participants, this.participantsWithAudio);
    private readonly shareWatch = inject(ShareWatchService);

    participantContextMenu = output<CallScreenLayoutContextMenuEvent>();
    localAudioToggle = output<void>();
    remoteAudioToggle = output<string>();

    protected readonly maximizedId = signal<string | null>(null);

    private readonly remoteShares = computed(() => this.screenShares().filter(s => !s.isLocal));
    private readonly localShare = computed(() => this.screenShares().find(s => s.isLocal) ?? null);

    /**
     * The shares that get a full tile.
     *
     * <p>Your own is dropped from the grid as soon as anybody else is sharing. It is a low-rate
     * thumbnail of something already on your own screen, and at full tile size it read as a broken
     * stream while taking half the room from the streams you opened the channel to watch. It moves
     * to the self-card instead, which is where a monitor of your own output belongs.</p>
     */
    protected displayedShares = computed(() => {
        const id = this.maximizedId();
        if (id !== null) return this.screenShares().filter(s => s.shareId === id);

        const remote = this.remoteShares();
        return remote.length > 0 ? remote : this.screenShares();
    });

    /** The local share when it is not in the grid - see {@link displayedShares}. */
    protected selfCard = computed(() => {
        const local = this.localShare();
        if (!local) return null;
        return this.displayedShares().some(s => s.shareId === local.shareId) ? null : local;
    });

    /** Columns for the count actually on screen. Two was the only answer before, so three streams
     *  left a lone tile stranded on its own row at half width. */
    protected gridClass = computed(() => {
        const count = this.displayedShares().length;
        if (count <= 1) return 'grid-cols-1';
        if (count <= 4) return 'grid-cols-2';
        return 'grid-cols-3';
    });
    private readonly _zoom = signal<Record<string, number>>({});
    private readonly _pan = signal<Record<string, { x: number; y: number }>>({});
    private dragging: {
        shareId: string;
        startX: number;
        startY: number;
        originX: number;
        originY: number;
    } | null = null;

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

    protected getZoom(shareId: string): number {
        return this._zoom()[shareId] ?? 1;
    }

    protected getPan(shareId: string): { x: number; y: number } {
        return this._pan()[shareId] ?? {x: 0, y: 0};
    }

    protected transformFor(shareId: string): string {
        const {x, y} = this.getPan(shareId);
        return `translate(${x}px, ${y}px) scale(${this.getZoom(shareId)})`;
    }

    /** Panning only means anything once the content is larger than its tile. */
    protected startPan(shareId: string, event: MouseEvent): void {
        if (this.getZoom(shareId) <= 1) return;
        event.preventDefault();
        const origin = this.getPan(shareId);
        this.dragging = {
            shareId,
            startX: event.clientX,
            startY: event.clientY,
            originX: origin.x,
            originY: origin.y,
        };
    }

    protected movePan(event: MouseEvent): void {
        const drag = this.dragging;
        if (!drag) return;
        this._pan.update(p => ({
            ...p,
            [drag.shareId]: {
                x: drag.originX + (event.clientX - drag.startX),
                y: drag.originY + (event.clientY - drag.startY),
            },
        }));
    }

    protected endPan(): void {
        this.dragging = null;
    }

    protected getShareForUser(userId: string): CallScreenShare | undefined {
        return this.screenShares().find(s => s.userId === userId);
    }

    protected zoomIn(shareId: string, event: MouseEvent): void {
        event.stopPropagation();
        const cur = this.getZoom(shareId);
        if (cur < 3) this._zoom.update(z => ({...z, [shareId]: +(cur + 0.25).toFixed(2)}));
    }

    protected zoomOut(shareId: string, event: MouseEvent): void {
        event.stopPropagation();
        const cur = this.getZoom(shareId);
        if (cur <= 1) return;
        const next = Math.max(1, +(cur - 0.25).toFixed(2));
        this._zoom.update(z => ({...z, [shareId]: next}));
        // Back at 1x the content fits the tile again, so any pan offset would only push it
        // off-centre with no way to see what was hidden.
        if (next === 1) this._pan.update(p => ({...p, [shareId]: {x: 0, y: 0}}));
    }

    protected toggleMaximize(shareId: string, event: MouseEvent): void {
        event.stopPropagation();
        this.maximizedId.update(id => id === shareId ? null : shareId);
    }

    /**
     * Fullscreens a share.
     *
     * <p>The tile, not the &lt;video&gt;: the name pill, the LIVE badge and the viewer count go
     * with it. Distinct from {@link toggleMaximize}, which only stops the *other* tiles being
     * rendered - the pane, its header and the rest of the app stay exactly where they were, which
     * is not what anybody means by fullscreen.</p>
     */
    protected toggleFullscreen(event: MouseEvent): void {
        event.stopPropagation();
        const tile = (event.currentTarget as HTMLElement).closest('.share-tile') as HTMLElement | null;
        if (!tile) return;
        if (document.fullscreenElement) document.exitFullscreen().catch(() => void 0);
        else tile.requestFullscreen().catch(() => void 0);
    }

    /** Promotes the self-card into the grid, so a streamer can check their own output. */
    protected maximizeSelf(shareId: string): void {
        this.maximizedId.set(shareId);
    }

    protected pipShare(event: MouseEvent): void {
        event.stopPropagation();
        const tile = (event.currentTarget as HTMLElement).closest('.relative') as HTMLElement | null;
        const video = tile?.querySelector('video') as HTMLVideoElement | null;
        if (!video || !document.pictureInPictureEnabled) return;
        if (document.pictureInPictureElement === video) {
            document.exitPictureInPicture().catch(() => {
            });
        } else {
            video.requestPictureInPicture().catch(() => {
            });
        }
    }
}
