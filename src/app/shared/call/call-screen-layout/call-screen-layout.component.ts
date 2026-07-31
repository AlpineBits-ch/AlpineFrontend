import {Component, computed, input, output, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {CallParticipant, CallScreenLayoutContextMenuEvent, CallScreenShare} from '../call.types';
import {AppAvatarComponent} from '../../../components/avatar/avatar.component';
import {StreamSrcDirective} from '../../../directives/stream-src.directive';

@Component({
    selector: 'app-call-screen-layout',
    imports: [NgClass, AppAvatarComponent, StreamSrcDirective],
    templateUrl: './call-screen-layout.component.html',
    host: {
        class: 'flex flex-col min-h-0'
    }
})
export class CallScreenLayoutComponent {
    screenShares = input.required<CallScreenShare[]>();
    participants = input.required<CallParticipant[]>();
    participantsWithAudio = input.required<Set<string>>();

    participantContextMenu = output<CallScreenLayoutContextMenuEvent>();
    localAudioToggle = output<void>();
    remoteAudioToggle = output<string>();

    protected readonly maximizedId = signal<string | null>(null);
    protected displayedShares = computed(() => {
        const id = this.maximizedId();
        return id === null ? this.screenShares() : this.screenShares().filter(s => s.shareId === id);
    });
    protected gridClass = computed(() =>
        this.maximizedId() === null && this.screenShares().length > 1 ? 'grid-cols-2' : 'grid-cols-1'
    );
    private readonly _zoom = signal<Record<string, number>>({});
    private readonly _pan = signal<Record<string, { x: number; y: number }>>({});
    private dragging: {
        shareId: string;
        startX: number;
        startY: number;
        originX: number;
        originY: number;
    } | null = null;

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
