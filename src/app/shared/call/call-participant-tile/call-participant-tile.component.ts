import {Component, input, output} from '@angular/core';
import {NgClass} from '@angular/common';
import {CallParticipant} from '../call.types';
import {AppAvatarComponent} from '../../../components/avatar/avatar.component';
import {StreamSrcDirective} from '../../../directives/stream-src.directive';

@Component({
    selector: 'app-call-participant-tile',
    imports: [NgClass, AppAvatarComponent, StreamSrcDirective],
    templateUrl: './call-participant-tile.component.html',
})
export class CallParticipantTileComponent {
    participant = input.required<CallParticipant>();
    hasAudio = input.required<boolean>();
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
}
