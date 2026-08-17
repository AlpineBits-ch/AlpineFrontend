import {
    ChangeDetectionStrategy,
    Component,
    computed,
    ElementRef,
    input,
    output,
    viewChild,
} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {CallParticipant, cameraTile} from '../call.types';
import {WatchScope} from '../../../services/share-watch.service';
import {trackTileHeight} from '../tile-height';
import {AppAvatarComponent} from '../../../components/avatar/avatar.component';
import {StreamSrcDirective} from '../../../directives/stream-src.directive';
import {AudioState} from '../audio-wait';
import {CallAudioStatusComponent} from '../call-audio-status/call-audio-status.component';
import {CallLiveBadgeComponent} from '../call-live-badge/call-live-badge.component';
import {CallTileActionComponent} from '../call-tile-action/call-tile-action.component';
import {videoPipSupported} from '../pip-support';

@Component({
    selector: 'app-call-participant-tile',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        TranslateModule,
        AppAvatarComponent,
        StreamSrcDirective,
        CallAudioStatusComponent,
        CallLiveBadgeComponent,
        CallTileActionComponent,
    ],
    templateUrl: './call-participant-tile.component.html',
})
export class CallParticipantTileComponent {
    readonly participant = input.required<CallParticipant>();
    readonly audioState = input.required<AudioState>();
    readonly videoStream = input<MediaStream | null>(null);
    /**
     * Which room this seat belongs to, so its rendered size can be reported and the camera served
     * at a matching simulcast layer - see {@link trackTileHeight}. Null (the default, and what a
     * surface that has not been wired for it passes) reports nothing.
     */
    readonly tileScope = input<WatchScope | null>(null);

    contextMenu = output<MouseEvent>();

    protected readonly root = viewChild.required<ElementRef<HTMLElement>>('root');
    protected readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');

    constructor() {
        trackTileHeight(
            this.root,
            this.tileScope,
            computed(() => cameraTile(this.participant()).id),
            computed(() => (this.participant().isLocal ? null : this.participant().userId)),
        );
    }

    /**
     * The camera tile only renders its PiP button once a `MediaStream` already exists - see the
     * `@if (p.isCameraOn && videoStream())` guard in the template - and `togglePip()` only ever does
     * video-element PiP, so the only thing left to gate is whether the environment supports that.
     */
    protected readonly canPip = computed(() => videoPipSupported());

    protected togglePip(): void {
        const video = this.video()?.nativeElement;
        if (!video || !videoPipSupported()) return;
        if (document.pictureInPictureElement === video)
            void document.exitPictureInPicture().catch(() => void 0);
        else void video.requestPictureInPicture().catch(() => void 0);
    }

    /**
     * Fullscreens the tile, video and name overlay together.
     *
     * <p>The tile rather than the &lt;video&gt; element: a fullscreened video is bare browser chrome
     * with no idea whose face it is showing.</p>
     */
    protected toggleFullscreen(): void {
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => void 0);
        else
            void this.root()
                .nativeElement.requestFullscreen()
                .catch(() => void 0);
    }
}
