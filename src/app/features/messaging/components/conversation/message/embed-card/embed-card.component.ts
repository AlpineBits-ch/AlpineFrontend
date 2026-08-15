import {ChangeDetectionStrategy, Component, computed, inject, input, output} from '@angular/core';
import {DatePipe} from '@angular/common';
import {LinkOpener} from '../../../../../../platform/ports/link-opener.port';
import {EmbedFlags, MessageEmbed, MessageEmbedMedia} from '../../../../../../dtos/response/message.dto';
import {MarkdownPipe} from '../../../../../../pipes/markdown.pipe';
import {EmbedMediaComponent} from './embed-media/embed-media.component';
import {EmbedPlayerComponent, isFramablePlayerUrl} from './embed-player/embed-player.component';
import {InviteCardComponent} from '../invite-card/invite-card.component';
import {WikiCardComponent} from '../wiki-card/wiki-card.component';

/**
 * How the card is laid out. Derived from `type`, then narrowed by what media actually arrived.
 *
 * <p>`none` is a real outcome, not a failure: an unrecognised `venta.*` type renders nothing at
 * all. Falling back to the link layout would draw half a card for a kind this build has never heard
 * of, and a future kind will arrive before the next release does.</p>
 */
type EmbedMode = 'plain-image' | 'gifv' | 'player' | 'card' | 'venta-invite' | 'venta-wiki' | 'none';

/**
 * One embed under a message - a bot's `rich` card, or a preview the server generated from a link.
 *
 * <p><b>Generated cards never get a markdown pass.</b> Their title, description, provider and
 * author are text a stranger wrote on a page we fetched: it arrives HTML-decoded and stripped of
 * control characters, but running it through markdown would let it resolve to an image or a link
 * of its own choosing. Bot-authored `rich` embeds keep markdown, because their author is someone
 * the guild deliberately installed.</p>
 */
@Component({
    selector: 'app-embed-card',
    imports: [
        MarkdownPipe, DatePipe, EmbedMediaComponent, EmbedPlayerComponent,
        InviteCardComponent, WikiCardComponent,
    ],
    templateUrl: './embed-card.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmbedCardComponent {
    embed = input.required<MessageEmbed>();

    /** Bubbles up so the message can open its lightbox - the card owns no overlay of its own. */
    openMedia = output<MessageEmbedMedia>();

    private readonly links = inject(LinkOpener);

    /**
     * Opens a URL from the card - a provider, an author or the embed's own link.
     *
     * <p>A method forwarding to {@link LinkOpener} rather than the plugin function it used to alias.
     * Every URL here came off a page the server fetched on someone's behalf, so it is a stranger's
     * text: the web adapter is what refuses a scheme a browser must not follow and sets `noopener` on
     * the tab it does open.</p>
     */
    protected openUrl(url: string): Promise<void> {
        return this.links.open(url);
    }

    protected readonly type = computed(() => this.embed().type ?? 'rich');

    protected readonly isGenerated = computed(() =>
        ((this.embed().flags ?? 0) & EmbedFlags.Generated) !== 0);

    protected readonly allowMarkdown = computed(() => !this.isGenerated() && this.type() === 'rich');

    protected readonly accentColor = computed(() => this.embed().color || 'var(--color-brand-dim)');

    /** Fields and footers are bot-only; a generated card that somehow carried them is not to be trusted. */
    protected readonly fields = computed(() =>
        this.isGenerated() ? [] : (this.embed().fields ?? []));

    protected readonly footerText = computed(() =>
        this.isGenerated() ? undefined : this.embed().footer?.text);

    /**
     * The player, but only if we are willing to frame its host. A whitelisted-looking URL we do not
     * recognise degrades to an ordinary link card rather than being framed on trust.
     */
    protected readonly player = computed(() => {
        const video = this.embed().video;
        return video && isFramablePlayerUrl(video.url) ? video : null;
    });

    protected readonly poster = computed(() => this.embed().thumbnail ?? this.embed().image);

    /** A GIF the origin serves as a video file - played inline, muted and looping, never framed. */
    protected readonly gifv = computed(() => {
        const embed = this.embed();
        if (this.type() !== 'gifv') return null;
        const media = embed.video ?? embed.image;
        return media && !isFramablePlayerUrl(media.url) ? media : null;
    });

    /**
     * Whether this is one of the instance's own links, vouched for by the server.
     *
     * <p><b>The flag is the whole check.</b> Without it the embed was written by whoever posted the
     * message, and a bot can author a `venta` block saying anything it likes. It buys an attacker
     * nothing on its own - every action a card offers runs through an authenticated,
     * permission-checked endpoint - but a card that looks server-vouched when it is not is a
     * phishing surface, and this is a one-line check.</p>
     */
    protected readonly venta = computed(() => {
        const embed = this.embed();
        return this.isGenerated() ? embed.venta : undefined;
    });

    protected readonly mode = computed<EmbedMode>(() => {
        const embed = this.embed();
        const type = this.type();

        if (type.startsWith('venta.')) {
            if (!this.venta()) return 'none';
            if (type === 'venta.invite') return 'venta-invite';
            if (type === 'venta.wiki_page') return 'venta-wiki';
            return 'none';
        }

        if (type === 'image' && (embed.image ?? embed.thumbnail)) return 'plain-image';
        if (this.gifv()) return 'gifv';
        if (this.player()) return 'player';
        return 'card';
    });

    protected readonly plainImage = computed(() => this.embed().image ?? this.embed().thumbnail);

    /** Large, full-width, below the text. */
    protected readonly hero = computed(() => {
        if (this.mode() !== 'card') return undefined;
        const embed = this.embed();
        return embed.image ?? (this.type() === 'article' ? embed.thumbnail : undefined);
    });

    /** Small, floated beside the text - the generic link-card shape. */
    protected readonly sideThumbnail = computed(() => {
        if (this.mode() !== 'card' || this.hero()) return undefined;
        return this.embed().thumbnail;
    });

    protected readonly gifSrc = computed(() => {
        const media = this.gifv();
        return media ? (media.proxy_url ?? media.url) : null;
    });

    protected readonly gifBox = computed(() => {
        const media = this.gifv();
        if (!media?.width || !media.height) return null;
        const scale = Math.min(400 / media.width, 300 / media.height, 1);
        return {width: Math.round(media.width * scale), height: Math.round(media.height * scale)};
    });

    /** True when the card has nothing but media - the text column is then dropped entirely. */
    protected readonly hasText = computed(() => {
        const embed = this.embed();
        return !!(embed.title || embed.description || embed.author?.name || embed.provider?.name
            || this.fields().length || this.footerText() || embed.timestamp);
    });

    protected readonly authorIcon = computed(() => {
        const author = this.embed().author;
        return author?.proxy_icon_url ?? author?.icon_url;
    });

    protected readonly footerIcon = computed(() => {
        const footer = this.embed().footer;
        return footer?.proxy_icon_url ?? footer?.icon_url;
    });
}
