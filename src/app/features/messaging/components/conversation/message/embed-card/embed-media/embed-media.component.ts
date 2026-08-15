import {ChangeDetectionStrategy, Component, computed, effect, input, output, signal} from '@angular/core';
import {MessageEmbedMedia} from '../../../../../../../dtos/response/message.dto';
import {blurHashToDataUrl} from '../../../../../../../helpers/blurhash.helper';

/**
 * One image on an embed - thumbnail, hero image or video poster.
 *
 * <p>Two things here are load-bearing rather than decorative:</p>
 *
 * <p><b>The source is always `proxy_url` when there is one.</b> Pointing an `<img>` at the origin's
 * own `url` hands that origin the IP address and read time of every person who scrolls past a link
 * somebody else posted - a tracking pixel nobody opted into. See {@link MessageEmbedMedia}.</p>
 *
 * <p><b>The box is sized before the image arrives.</b> Previews land seconds after the message, so
 * an unsized image would shove the whole message list downward the moment it decodes. The measured
 * `width`/`height` reserve the space and the BlurHash fills it in the meantime.</p>
 */
@Component({
    selector: 'app-embed-media',
    imports: [],
    templateUrl: './embed-media.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmbedMediaComponent {
    media = input.required<MessageEmbedMedia>();
    /** Widest the image may render, in px. The reserved box is scaled down to fit. */
    maxWidth = input<number>(400);
    /** Tallest the image may render, in px. */
    maxHeight = input<number>(300);
    alt = input<string>('');
    rounded = input<string>('rounded-lg');
    clickable = input<boolean>(true);

    /** Emitted on click, carrying the media so the message can open a lightbox for it. */
    open = output<MessageEmbedMedia>();

    protected readonly loaded = signal(false);
    protected readonly failed = signal(false);

    protected readonly src = computed(() => {
        const media = this.media();
        return media.proxy_url ?? media.url;
    });

    /**
     * The space to reserve, or null when the server measured nothing and there is none to reserve.
     */
    protected readonly box = computed<{ width: number; height: number } | null>(() => {
        const {width, height} = this.media();
        if (!width || !height) return null;
        const scale = Math.min(this.maxWidth() / width, this.maxHeight() / height, 1);
        return {width: Math.round(width * scale), height: Math.round(height * scale)};
    });

    protected readonly placeholder = computed(() => {
        const media = this.media();
        const ratio = media.width && media.height ? media.width / media.height : 1;
        return blurHashToDataUrl(media.placeholder, media.placeholder_version, ratio);
    });

    constructor() {
        // Embeds are re-parsed wholesale on every MessageUpdated, so one instance can be handed a
        // different image. Without this the new image inherits the old one's "already loaded"
        // state and pops in without its placeholder.
        effect(() => {
            this.src();
            this.loaded.set(false);
            this.failed.set(false);
        });
    }

    protected onClick(): void {
        if (this.clickable() && !this.failed()) this.open.emit(this.media());
    }
}
