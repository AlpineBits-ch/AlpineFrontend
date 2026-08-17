import {ChangeDetectionStrategy, Component, computed, effect, input, output, signal} from '@angular/core';
import {MessageEmbedMedia} from '../../../../../../../dtos/response/message.dto';
import {blurHashToDataUrl} from '../../../../../../../helpers/blurhash.helper';

/** One image on an embed - thumbnail, hero image or video poster. */
@Component({
    selector: 'app-embed-media',
    imports: [],
    templateUrl: './embed-media.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmbedMediaComponent {
    readonly media = input.required<MessageEmbedMedia>();
    /** Widest the image may render, in px. The reserved box is scaled down to fit. */
    readonly maxWidth = input<number>(400);
    /** Tallest the image may render, in px. */
    readonly maxHeight = input<number>(300);
    readonly alt = input<string>('');
    readonly rounded = input<string>('rounded-lg');
    readonly clickable = input<boolean>(true);

    /** Emitted on click, carrying the media so the message can open a lightbox for it. */
    open = output<MessageEmbedMedia>();

    protected readonly loaded = signal(false);
    protected readonly failed = signal(false);

    protected readonly src = computed(() => {
        const media = this.media();
        return media.proxy_url ?? media.url;
    });

    /** The space to reserve, or null when the server measured nothing and there is none to reserve. */
    protected readonly box = computed<{width: number; height: number} | null>(() => {
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
