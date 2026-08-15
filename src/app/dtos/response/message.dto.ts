import {MessageEncryptionState} from "../../enums/message-encryption-state.enum";
import {MessageType} from '../../enums/message-type.enum';

/**
 * <p>Deliberately has no `url`: the payload carries `thumbnailUrl` and nothing else, so code
 * reaching for "the attachment's URL" was getting `undefined` where the type promised a string -
 * or, worse, falling back to the thumbnail and downloading a downscaled preview. Build the
 * full-size address from the id with `FileService.attachmentDownloadUrl`.</p>
 */
export interface MessageAttachment {
    id: string;
    fileName: string;
    contentType: string;
    thumbnailUrl?: string;
}

export interface MessageReaction {
    contextId: string;
    messageId: string;
    emoji: string;
    emojiId?: string | null;
    userId: string;
    createdAt: string;
    conversationId: string | null;
    channelId: string | null;
}

export interface MessageEmbedField {
    name: string;
    value: string;
    inline: boolean;
}

/**
 * <p><b>Multi-word fields inside an embed are snake_case, and the message fields around them are
 * camelCase.</b> `embedsJson` is an opaque string produced by a different serializer - one whose
 * members carry explicit `[JsonPropertyName]` attributes that beat the camelCase policy - so
 * `message.editedAt` and `embed.author.icon_url` are both correct in the same payload. This client
 * read them as `iconUrl`/`proxyUrl`/`placeholderVersion` and so never saw one of them, which is why
 * every card was quietly hot-linking the origin instead of our proxy.</p>
 */
export interface MessageEmbedAuthor {
    name: string;
    url?: string;
    icon_url?: string;
    proxy_icon_url?: string;
}

export interface MessageEmbedFooter {
    text: string;
    icon_url?: string;
    proxy_icon_url?: string;
}

export interface MessageEmbedProvider {
    name: string;
    url?: string;
}

/**
 * Picks the card layout. Absent on older bot embeds, which are all `rich`.
 *
 * <p>The `venta.*` types are links back to this instance, resolved in-process rather than fetched.
 * They carry a {@link MessageEmbedVenta} block. An unrecognised `venta.*` type must be ignored
 * outright rather than falling back to the link layout - a future kind will arrive before the next
 * release, and a half-rendered card is worse than no card.</p>
 */
export type MessageEmbedType =
    'rich' | 'link' | 'article' | 'image' | 'video' | 'gifv'
    | 'venta.invite' | 'venta.wiki_page' | 'venta.voice_invite';

/**
 * The identity of whatever an instance-local link points at.
 *
 * <p><b>Identifiers only - never a URL to call, and there will never be one.</b> A refresh endpoint
 * supplied by the embed would be a URL a bot chose, hit with the user's credentials, which is a
 * credential harvester. Compose refresh requests from this client's own route table.</p>
 *
 * <p><b>Trust it only when the embed carries {@link EmbedFlags.Generated}.</b> Without the flag the
 * whole embed, this block included, was written by whoever posted the message.</p>
 */
export interface MessageEmbedVenta {
    /** `type` without the `venta.` prefix, so one value can be switched on. */
    kind: 'invite' | 'wiki_page' | 'voice_invite' | (string & {});
    /** Whether the server filled in title/description, or deliberately left them out. */
    resolved: boolean;
    guild_id?: string;

    /** Invite only. Always the canonical code, even when the pasted link was a vanity URL. */
    invite_code?: string;
    /**
     * Invite: the channel a joiner lands on. Voice invite: the channel being asked into.
     * An id, never a name - except on a voice invite, which also carries {@link channel_name}.
     */
    channel_id?: string;
    /**
     * ISO-8601. On an invite, absent means it never expires. On a voice invite it is always
     * present, is about a minute after the message was sent, and is what decides whether
     * {@link ring_id} still means anything.
     */
    expires_at?: string;
    /** Invite only. Absent for unlimited. */
    max_uses?: number;

    /** Wiki only. */
    page_id?: string;

    /**
     * Voice invite only: the ring this card was written for.
     *
     * <p>Live only until {@link expires_at}, which is about a minute after the message. Past that,
     * treat it as absent rather than as something to call - the ring no longer exists and accepting
     * it answers `409`.</p>
     */
    ring_id?: string;
    /**
     * Voice invite only: who did the asking. The same person as the message's author today; carried
     * so the card keeps meaning what it says if it is ever quoted.
     */
    inviter_id?: string;
    /**
     * Voice invite only: the channel's name when the invitation was sent.
     *
     * <p>The one place a `venta.*` card carries a name rather than only an id. The invite kind can
     * leave it out because a client re-resolves it from the code, and the wiki kind must leave it
     * out because the audience for a title is narrower than the audience for the message. Neither
     * applies here: the recipient was checked for `ViewChannel` before the ring was allowed at all,
     * and there is no later lookup that would let them fill it in. Render it; do not go and fetch a
     * fresher one.</p>
     */
    channel_name?: string;
}

/**
 * An image, thumbnail or player frame on an embed.
 *
 * <p><b>Render `proxy_url`, never `url`.</b> `url` is the third-party origin's own address, so
 * loading it hands that origin the IP address, rough location and read time of everyone who
 * scrolls past a link one other person posted. `proxy_url` is our re-hosted copy: unauthenticated
 * (an `<img>` carries no token), immutable, and cached for a week - so no cache-busting and no
 * `Authorization` header. Keep `url` for an "open original" affordance only.</p>
 */
export interface MessageEmbedMedia {
    /** The origin's own URL. Do not put this in a `src`. */
    url: string;
    /** Our re-hosted copy - a fully-qualified absolute URL. Absent if the media was not fetched. */
    proxy_url?: string;
    /** True measured pixel dimensions. Used to reserve layout space before the image loads. */
    width?: number;
    height?: number;
    content_type?: string;
    /** BlurHash string - decoded into a blurred placeholder while the real image loads. */
    placeholder?: string;
    /** Which encoding `placeholder` uses. 1 = BlurHash; anything else must be ignored. */
    placeholder_version?: number;
}

/**
 * A card under a message: either written by a bot (`rich`) or generated by the server from a link.
 *
 * <p>Everything here comes from a third-party page and is attacker-controlled text. It arrives
 * HTML-decoded and stripped of control characters, but it is still text a stranger wrote - render
 * it as text, never as HTML and never through a markdown pass that could resolve to an image.</p>
 */
export interface MessageEmbed {
    type?: MessageEmbedType;
    title?: string;
    description?: string;
    url?: string;
    /** ISO-8601. The *content's* date (e.g. publication), not when it was unfurled. */
    timestamp?: string;
    color?: string | null;
    provider?: MessageEmbedProvider;
    author?: MessageEmbedAuthor;
    /** Small, beside the text - also the poster frame for a video. */
    thumbnail?: MessageEmbedMedia;
    /** Large, full-width below the text. */
    image?: MessageEmbedMedia;
    /** The in-app player. Only ever a server-whitelisted provider; still sandboxed on render. */
    video?: MessageEmbedMedia;
    /** Bots only, at most 25. Generated previews never populate this. */
    fields?: MessageEmbedField[];
    footer?: MessageEmbedFooter;
    /** Bitfield - see {@link EmbedFlags}. */
    flags?: number;
    /** Present only on `venta.*` embeds. Trust it only when {@link EmbedFlags.Generated} is set. */
    venta?: MessageEmbedVenta;
}

export const EmbedFlags = {
    /** Bit 16: generated by the server from a link, rather than written by the message's author. */
    Generated: 1 << 16,
} as const;

/** Discord-compatible message bitfield. */
export const MessageFlags = {
    /** Bit 2: a person removed this message's previews, for everyone who can see it. */
    SuppressEmbeds: 1 << 2,
} as const;

export interface MessageDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    content: string;
    channelId: string | undefined;
    conversationId: string | undefined;
    authorId: string;
    isPending: boolean;
    isFailed: boolean;
    attachments: MessageAttachment[];
    inReplyTo: string | undefined;
    mentions: string[];
    roleMentions?: string[];
    mentionsEveryone?: boolean;
    mentionsHere?: boolean;
    encryptionState: MessageEncryptionState;
    mlsEpoch: number | undefined;
    mlsSequenceNumber: number | undefined;
    /** Which encryption era of the context this ciphertext belongs to. Null on plaintext. */
    mlsGeneration?: number | null;
    /** Client-only: ciphertext this device can no longer read - MLS ratchets forward only. */
    undecryptable?: boolean;
    senderDeviceId: string | undefined;
    type: MessageType;
    reactions?: MessageReaction[];
    /** Client-only: marks this entity as a synthetic placeholder for an in-flight/failed bot command invocation, not a real persisted message. */
    isBotCommandPlaceholder?: boolean;
    /**
     * Client-only: a bot reply only this user was sent, which the server never stored
     * (`guild.EphemeralMessageCreated`).
     *
     * <p>It lives in the store so the channel can render it, and nowhere else - a reload loses it,
     * which is the whole point. Nothing may offer edit, delete, pin or reply on it: there is no
     * server-side row for any of those to act on, and every one of them would 404.</p>
     */
    isEphemeral?: boolean;
    embedsJson?: string;
    /**
     * When the **author** last changed the text, or null if they never did.
     *
     * <p>This is what drives the "(edited)" marker - never `updatedAt`. `updatedAt` is bumped by
     * anything that writes the row, including a preview attaching a second after the message was
     * posted, so driving the marker off it labels every message containing a link as edited by
     * nobody.</p>
     */
    editedAt?: string | null;
    /** Message bitfield - see {@link MessageFlags}. */
    flags?: number;
    systemMessageVariant?: number;
    isPinned?: boolean;
    pinnedAt?: string;
    pinnedById?: string;
}

export interface EmbedSuppressionResponse {
    messageId: string;
    suppressed: boolean;
}

export interface PinMessageResponse {
    success: boolean;
    channelId?: string;
    conversationId?: string;
    authorId?: string;
    pinnedById?: string;
    pinnedAt?: string;
}
