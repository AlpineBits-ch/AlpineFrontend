import {Component, input, output} from '@angular/core';
import {NgClass} from '@angular/common';
import {CallParticipant} from '../call.types';
import {AppAvatarComponent} from '../../../components/avatar/avatar.component';
import {StreamSrcDirective} from '../../../directives/stream-src.directive';
import {AudioState} from '../audio-wait';
import {CallAudioStatusComponent} from '../call-audio-status/call-audio-status.component';

@Component({
    selector: 'app-call-participant-tile',
    imports: [NgClass, AppAvatarComponent, StreamSrcDirective, CallAudioStatusComponent],
    templateUrl: './call-participant-tile.component.html',
})
export class CallParticipantTileComponent {
    participant = input.required<CallParticipant>();
    audioState = input.required<AudioState>();
    videoStream = input<MediaStream | null>(null);

    contextMenu = output<MouseEvent>();

    protected pipVideo(event: MouseEvent): void {
        event.stopPropagation();
        const tile = (event.currentTarget as HTMLElement).closest('.group') as HTMLElement | null;
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

    /**
     * Fullscreens the tile, video and name overlay together.
     *
     * <p>The tile rather than the &lt;video&gt; element: a fullscreened video is bare browser chrome
     * with no idea whose face it is showing.</p>
     */
    protected toggleFullscreen(event: MouseEvent): void {
        event.stopPropagation();
        const tile = (event.currentTarget as HTMLElement).closest('.group') as HTMLElement | null;
        if (!tile) return;
        if (document.fullscreenElement) document.exitFullscreen().catch(() => void 0);
        else tile.requestFullscreen().catch(() => void 0);
    }
}
