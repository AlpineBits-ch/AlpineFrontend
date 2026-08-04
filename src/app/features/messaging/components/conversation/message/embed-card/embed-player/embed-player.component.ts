import {ChangeDetectionStrategy, Component, computed, effect, inject, input, signal} from '@angular/core';
import {DomSanitizer} from '@angular/platform-browser';
import {MessageEmbedMedia} from '../../../../../../../dtos/response/message.dto';
import {EmbedMediaComponent} from '../embed-media/embed-media.component';

/**
 * Hosts whose players we are willing to put in a frame.
 *
 * <p>The server already builds `video.url` from an extracted id against its own whitelist, so a
 * page cannot choose what we frame. This list is the second lock: it is the client that decides
 * what the client loads, and a compromised or misconfigured unfurler should not be able to talk
 * this component into framing an arbitrary document.</p>
 */
const PLAYER_HOSTS = new Set([
    'www.youtube.com',
    'youtube.com',
    'www.youtube-nocookie.com',
    'youtube-nocookie.com',
    'player.vimeo.com',
    'player.twitch.tv',
    'open.spotify.com',
]);

export function isFramablePlayerUrl(raw: string | undefined): boolean {
    if (!raw) return false;
    try {
        const url = new URL(raw);
        return url.protocol === 'https:' && PLAYER_HOSTS.has(url.hostname);
    } catch {
        return false;
    }
}

/**
 * Click-to-load player for embeds that carry a `video`.
 *
 * <p><b>The frame is never loaded until it is asked for.</b> An iframe is a third-party document:
 * mounting it as the card scrolls into view tells YouTube - or Spotify, or Twitch - that this
 * person read this message, before they expressed any interest at all. So the card shows the
 * poster frame and a play button, and the frame appears on click and not before.</p>
 *
 * <p>The frame is sandboxed even though the URL came from a server-side whitelist. Whitelisting
 * decides *whose* document loads; the sandbox decides what that document may then do.</p>
 */
@Component({
    selector: 'app-embed-player',
    imports: [EmbedMediaComponent],
    templateUrl: './embed-player.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmbedPlayerComponent {
    video = input.required<MessageEmbedMedia>();
    /** Poster frame - the embed's thumbnail or image. */
    poster = input<MessageEmbedMedia | undefined>(undefined);
    title = input<string>('');
    maxWidth = input<number>(432);

    protected readonly playing = signal(false);
    private readonly sanitizer = inject(DomSanitizer);

    protected readonly framable = computed(() => isFramablePlayerUrl(this.video().url));

    protected readonly frameSrc = computed(() =>
        this.framable() ? this.sanitizer.bypassSecurityTrustResourceUrl(this.video().url) : null);

    /**
     * Real aspect ratio, from the measured player size - a Spotify embed is a short bar and a
     * YouTube one is 16:9, so hardcoding either is wrong half the time.
     */
    protected readonly box = computed(() => {
        const {width, height} = this.video();
        const ratio = width && height ? width / height : 16 / 9;
        const w = this.maxWidth();
        return {width: w, height: Math.round(w / ratio)};
    });

    constructor() {
        // A different video on the same card must not inherit the previous one's open frame.
        effect(() => {
            this.video().url;
            this.playing.set(false);
        });
    }

    protected play(): void {
        if (this.framable()) this.playing.set(true);
    }
}
