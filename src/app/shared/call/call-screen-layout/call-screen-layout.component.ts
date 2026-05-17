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

    protected getZoom(shareId: string): number {
        return this._zoom()[shareId] ?? 1;
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
        if (cur > 1) this._zoom.update(z => ({...z, [shareId]: Math.max(1, +(cur - 0.25).toFixed(2))}));
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
