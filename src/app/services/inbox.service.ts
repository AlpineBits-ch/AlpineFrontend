import {computed, effect, inject, Injectable, signal} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {debounceTime, firstValueFrom} from 'rxjs';
import {ChannelDto, ChannelType, GuildDto} from '../dtos/response/guild.dto';
import {MessageDto} from '../dtos/response/message.dto';
import {MessageEncryptionState} from '../enums/message-encryption-state.enum';
import {MessageType} from '../enums/message-type.enum';
import {
    INBOX_MESSAGE_TYPES,
    InboxBreadcrumb,
    InboxMention,
    InboxMentionAdded,
    InboxMessage,
    InboxReadStateChanged,
    InboxSummary,
    InboxUnreadGroup,
} from '../dtos/response/inbox.dto';
import {InboxApiService} from './inbox-api.service';
import {GuildService} from './guild.service';
import {GuildReadStateService} from './guild-read-state.service';
import {ConversationStore} from '../stores/conversation.store';
import {ProfileService} from './profile.service';
import {NavigationService} from '../features/main-page/navigation.service';
import {ConnectionState, RealtimeConnectionService} from './realtime-connection.service';
import {MlsService} from './mls.service';
import {MlsSyncService} from './mls-sync.service';
import {MlsHealthService} from './mls-health.service';
import {decryptMessages} from '../helpers/message-decrypt';

/** How many groups/mentions to ask for per page. Both are clamped server-side. */
const UNREAD_PAGE_SIZE = 10;
const MENTIONS_PAGE_SIZE = 25;

/**
 * How many empty-but-cursored pages one `loadMore` will chase before giving up.
 *
 * <p>Muting and permission filtering are applied *after* a page is taken, so a page can come back
 * with no rows and still have a `nextCursor` - that means "keep going", not "you're done". Chasing
 * it inside one call is what stops the user having to press Load more ten times to see one row;
 * the bound is what stops a pathological run spinning forever.</p>
 */
const MAX_EMPTY_HOPS = 10;

/**
 * How long a burst of channel reads is allowed to settle before the badge is refetched.
 *
 * <p>Clicking through a server marks a channel read per stop, and each one moves the badge. The
 * count is one cheap request, so the trailing edge of the burst is where to spend it.</p>
 */
const READ_RESYNC_DEBOUNCE_MS = 2_000;

/** A preview whose body could not be decoded, so the row still says *something*. */
export interface InboxPreview {
    /** The decrypted (or plain) message, ready for `readableContent`. */
    message: MessageDto;
    authorDisplayName: string | null;
    authorAvatarUrl: string | null;
}

/** One unread channel, with its previews already through the decryptor. */
export interface InboxUnreadEntry {
    breadcrumb: InboxBreadcrumb;
    lastActivityAt: string;
    unreadCount: number;
    mentionCount: number;
    previews: InboxPreview[];
    previewsTruncated: boolean;
}

/** One mention, with its message already through the decryptor. */
export interface InboxMentionEntry {
    mention: InboxMention;
    preview: InboxPreview;
}

/**
 * Everything waiting for the user, from every guild and every DM at once.
 *
 * <p>The sidebar answers "what is unread *here*". This answers "what is unread anywhere", which no
 * client-side aggregate could do honestly - before the inbox API existed this service summed
 * `GuildReadStateService`, and that meant one `getOwnMember` request per guild just to see servers
 * the user had not opened. The server now owns the question. {@link GuildReadStateService} is
 * untouched: the sidebar's per-channel dots are still its.</p>
 *
 * <p>Two rules from the API run through everything here. Ids are opaque - they sort by creation
 * time only if minted after the ULID change - so nothing compares two of them; `lastActivityAt`
 * and `createdAt` order the lists. And paging stops on a null cursor, never on a short or empty
 * page.</p>
 */
@Injectable({providedIn: 'root'})
export class InboxService {
    private api = inject(InboxApiService);
    private guildService = inject(GuildService);
    private readState = inject(GuildReadStateService);
    private conversationStore = inject(ConversationStore);
    private profileService = inject(ProfileService);
    private navService = inject(NavigationService);
    private realtime = inject(RealtimeConnectionService);
    private mlsService = inject(MlsService);
    private mlsSync = inject(MlsSyncService);
    private mlsHealth = inject(MlsHealthService);

    // ── Unread tab ──────────────────────────────────────────────────────────
    private readonly _unread = signal<InboxUnreadEntry[]>([]);
    readonly unread = this._unread.asReadonly();
    private unreadCursor: string | null = null;
    readonly unreadLoading = signal(false);
    readonly unreadHasMore = signal(false);
    readonly unreadFailed = signal(false);

    /**
     * The message service could not be reached, so the rows carry no bodies.
     *
     * <p>Groups, counts and breadcrumbs come from a different service and are still correct, so
     * this renders the tab without previews rather than an error - and retries once in the
     * background, which the spec says is reasonable.</p>
     */
    readonly previewsUnavailable = signal(false);

    // ── Mentions tab ────────────────────────────────────────────────────────
    private readonly _mentions = signal<InboxMentionEntry[]>([]);
    readonly mentions = this._mentions.asReadonly();
    private mentionsCursor: string | null = null;
    readonly mentionsLoading = signal(false);
    readonly mentionsHasMore = signal(false);
    readonly mentionsFailed = signal(false);

    // ── Badge ───────────────────────────────────────────────────────────────
    private readonly _summary = signal<InboxSummary>(
        {unreadChannelCount: 0, mentionCount: 0, capped: false});
    readonly summary = this._summary.asReadonly();

    /**
     * What the titlebar badge draws, or null for no badge at all.
     *
     * <p>Both counts, added. A mention is the louder of the two, but a badge that only counted
     * mentions stayed dark through a DM and a full channel of replies - which is exactly the
     * activity the button exists to lead the user back to.</p>
     *
     * <p>`capped` means the server stopped counting before it finished, so the numbers are a floor
     * and the sum of two floors is still a floor - it renders as `99+` whatever it adds up to.</p>
     */
    readonly badgeLabel = computed(() => {
        const {unreadChannelCount, mentionCount, capped} = this._summary();
        const total = unreadChannelCount + mentionCount;
        if (total <= 0) return null;
        return capped || total > 99 ? '99+' : String(total);
    });

    /** Whether the last state the connection effect saw was `Connected`, so it can spot edges. */
    private wasConnected = false;

    constructor() {
        // Registered here rather than in a dedicated `inbox-websocket.service.ts`: there are two
        // events and one consumer, and a pass-through service would be ceremony. This is a root
        // singleton injected by the always-rendered titlebar, so registration happens exactly once
        // at bootstrap, and `on` is safe before `start`.
        this.realtime.on('inbox.MentionAdded', (d: InboxMentionAdded) => this.onMentionAdded(d));
        this.realtime.on('inbox.ReadStateChanged', (d: InboxReadStateChanged) => this.onReadStateChanged(d));

        // The badge is fetched here rather than left to `open`, which is what the popout calls.
        // Fetching it only on open meant the count arrived at the one moment nobody needed it -
        // on a cold start the summary was zeroed, so the button drew no badge until the user
        // opened the panel that would have told them anyway.
        //
        // On the connected edge specifically, for two reasons. It is the first moment there is a
        // session to ask about - the titlebar renders on the login route too, and this service is
        // constructed with it. And a reconnect lands on the same edge: SignalR replays nothing it
        // dropped, so every `MentionAdded` that fired while the socket was down is invisible until
        // something refetches, which is this.
        effect(() => {
            const connected = this.realtime.connectionState() === ConnectionState.Connected;
            if (connected === this.wasConnected) return;
            this.wasConnected = connected;
            if (connected) void this.refreshSummary();
        });

        // Reading a channel is the ordinary way the badge goes down, and the read happens in the
        // channel view, which knows nothing about the inbox. Refetched rather than decremented:
        // the local read state and the server's unread set are built from different inputs, so
        // arithmetic across them drifts, and this costs one request per burst to be exactly right.
        this.readState.channelRead$.pipe(
            debounceTime(READ_RESYNC_DEBOUNCE_MS),
            takeUntilDestroyed(),
        ).subscribe(() => void this.refreshSummary());
    }

    // ── Loading ─────────────────────────────────────────────────────────────

    /**
     * Called when the popout is shown.
     *
     * <p>Both tabs are fetched, not just the visible one: they land independently and whichever
     * arrives first renders, which beats making the user pay a request when they switch tab.</p>
     *
     * <p>Every open starts from the first page rather than keeping what was there. The lists
     * reorder as messages arrive, so a keyset cursor held across a closed popout describes a list
     * that no longer exists - and anything read in another window in between is still on screen.
     * Whatever had been paged in is discarded with it, which is the right trade for a surface the
     * user just reopened.</p>
     */
    open(): void {
        this._unread.set([]);
        this._mentions.set([]);
        this.unreadCursor = null;
        this.mentionsCursor = null;
        this.previewsUnavailable.set(false);
        void this.refreshSummary();
        void this.loadMoreUnread();
        void this.loadMoreMentions();
    }

    async loadMoreUnread(): Promise<void> {
        if (this.unreadLoading()) return;
        this.unreadLoading.set(true);
        this.unreadFailed.set(false);
        try {
            let hops = 0;
            // Keeps going while the server hands back an empty page with a live cursor. Stopping
            // on `groups.length === 0` is the single easiest thing to get wrong against this API.
            while (hops++ < MAX_EMPTY_HOPS) {
                const page = await firstValueFrom(
                    this.api.unread(UNREAD_PAGE_SIZE, this.unreadCursor));
                this.unreadCursor = page.nextCursor;
                this.unreadHasMore.set(page.nextCursor !== null);
                this.previewsUnavailable.set(page.previewsUnavailable);

                if (page.groups.length > 0) {
                    const entries = await Promise.all(page.groups.map(g => this.toUnreadEntry(g)));
                    this._unread.update(list => [...list, ...entries]);
                    break;
                }
                if (page.nextCursor === null) break;
            }
            if (this.previewsUnavailable()) this.retryPreviewsLater();
        } catch {
            this.unreadFailed.set(true);
        } finally {
            this.unreadLoading.set(false);
        }
    }

    async loadMoreMentions(): Promise<void> {
        if (this.mentionsLoading()) return;
        this.mentionsLoading.set(true);
        this.mentionsFailed.set(false);
        try {
            let hops = 0;
            // Deleted messages are skipped rather than rendered as a hole, so a page can be shorter
            // than `limit` - or empty - while more pages exist. Same rule as unread.
            while (hops++ < MAX_EMPTY_HOPS) {
                const page = await firstValueFrom(this.api.mentions({
                    limit: MENTIONS_PAGE_SIZE,
                    cursor: this.mentionsCursor,
                }));
                this.mentionsCursor = page.nextCursor;
                this.mentionsHasMore.set(page.nextCursor !== null);

                if (page.mentions.length > 0) {
                    const entries = await Promise.all(page.mentions.map(m => this.toMentionEntry(m)));
                    this._mentions.update(list => [...list, ...entries]);
                    break;
                }
                if (page.nextCursor === null) break;
            }
        } catch {
            this.mentionsFailed.set(true);
        } finally {
            this.mentionsLoading.set(false);
        }
    }

    async refreshSummary(): Promise<void> {
        try {
            this._summary.set(await firstValueFrom(this.api.summary()));
        } catch {
            // The badge keeps whatever it had. A failed count is not worth surfacing.
        }
    }

    // ── Actions ─────────────────────────────────────────────────────────────

    /**
     * The ✓ on an unread row.
     *
     * <p>Optimistic: the row goes immediately and comes back on failure. The sidebar's own dot is
     * cleared in the same gesture, so the two surfaces never disagree about a channel the user has
     * just dismissed.</p>
     */
    async markChannelRead(channelId: string): Promise<void> {
        const before = this._unread();
        const removed = before.find(e => e.breadcrumb.channelId === channelId);
        if (!removed) return;

        this._unread.set(before.filter(e => e.breadcrumb.channelId !== channelId));
        this.readState.markChannelRead(channelId);
        this.adjustSummary(-1, -removed.mentionCount);

        try {
            await firstValueFrom(this.api.markChannelRead(channelId));
        } catch {
            this._unread.set(before);
            this.adjustSummary(1, removed.mentionCount);
        }
    }

    /** The Mark all button. Clears both lists and the badge; restores nothing on failure but refetches. */
    async markAllRead(): Promise<void> {
        const beforeUnread = this._unread();
        const beforeSummary = this._summary();
        this._unread.set([]);
        this.unreadCursor = null;
        this.unreadHasMore.set(false);
        this._summary.set({unreadChannelCount: 0, mentionCount: 0, capped: false});
        for (const entry of beforeUnread) this.readState.markChannelRead(entry.breadcrumb.channelId);

        try {
            await firstValueFrom(this.api.readAll());
        } catch {
            this._unread.set(beforeUnread);
            this._summary.set(beforeSummary);
        }
    }

    /**
     * The ✕ on a mention row.
     *
     * <p>`createdAt` is passed straight through from the row the server gave us. Re-deriving it
     * from the message's own timestamp would deviate by whatever the two disagree about, and the
     * index is keyed on it - the delete would return `204` and remove nothing.</p>
     */
    async dismissMention(entry: InboxMentionEntry): Promise<void> {
        const before = this._mentions();
        this._mentions.set(before.filter(e => e.mention.messageId !== entry.mention.messageId));
        this.adjustSummary(0, -1);

        try {
            await firstValueFrom(this.api.dismissMention(
                entry.mention.messageId, entry.mention.createdAt));
        } catch {
            this._mentions.set(before);
            this.adjustSummary(0, 1);
        }
    }

    /** Jumps to whatever an unread row points at, switching workspace first when it is elsewhere. */
    openUnread(entry: InboxUnreadEntry): void {
        this.openBreadcrumb(entry.breadcrumb);
    }

    /** Jumps to whatever a mention points at - a guild channel, or the DM it arrived in. */
    openMention(entry: InboxMentionEntry): void {
        const {breadcrumb, conversationId} = entry.mention;
        if (breadcrumb) {
            this.openBreadcrumb(breadcrumb);
            return;
        }
        if (!conversationId) return;
        const conversation = this.conversationStore.entities().find(c => c.id === conversationId);
        if (conversation) this.navService.openConversation(conversation);
    }

    /**
     * The `#`, `🔊` or `↳` in front of a channel name.
     *
     * <p>Resolved from the loaded guild rather than from `breadcrumb.channelType`: that field is
     * numeric on this endpoint while {@link ChannelType} is a string enum everywhere else, and the
     * spec never enumerates its values. A guessed mapping would silently mislabel channels, so an
     * unresolvable one gets the neutral `#`.</p>
     */
    channelGlyph(breadcrumb: InboxBreadcrumb): string {
        const channel = this.resolveChannel(breadcrumb);
        switch (channel?.type) {
            case ChannelType.Voice:
                return '🔊';
            case ChannelType.Thread:
                return '↳';
            case ChannelType.Forum:
            case ChannelType.Media:
                return '💬';
            case ChannelType.Announcement:
                return '📢';
            default:
                return '#';
        }
    }

    // ── Realtime ────────────────────────────────────────────────────────────

    /**
     * A new mention arrived.
     *
     * <p>The badge is bumped from the event rather than refetched - the whole point of the event is
     * that `/summary` is cheap but not free. The list itself is left alone: the payload has no
     * message body or breadcrumb, so a row built from it would be a worse row than the one the next
     * fetch produces, and the popout refetches on open anyway.</p>
     */
    private onMentionAdded(event: InboxMentionAdded): void {
        if (this._mentions().some(e => e.mention.messageId === event.messageId)) return;
        this.adjustSummary(0, 1);
    }

    private onReadStateChanged(event: InboxReadStateChanged): void {
        // Read-all from another device. Looking for a channel id here would silently ignore it.
        if (event.all) {
            this._unread.set([]);
            this.unreadCursor = null;
            this.unreadHasMore.set(false);
            this._summary.set({unreadChannelCount: 0, mentionCount: 0, capped: false});
            return;
        }
        if (!event.channelId) return;

        const before = this._unread();
        const removed = before.find(e => e.breadcrumb.channelId === event.channelId);
        if (!removed) return;
        this._unread.set(before.filter(e => e.breadcrumb.channelId !== event.channelId));
        this.adjustSummary(-1, (event.mentionCount ?? 0) - removed.mentionCount);
    }

    // ── Internals ───────────────────────────────────────────────────────────

    private openBreadcrumb(breadcrumb: InboxBreadcrumb): void {
        const guild = this.guildService.guilds().find(g => g.id === breadcrumb.guildId);
        if (!guild) return;
        const channel = this.resolveChannel(breadcrumb, guild);
        this.navService.selectServer(guild);
        if (channel) this.navService.openChannel(channel);
    }

    /**
     * The loaded `ChannelDto` behind a breadcrumb.
     *
     * <p>Threads and forum posts are not always in `guild.channels` - they are loaded with their
     * parent - so one that is missing falls back to the parent the breadcrumb names. Opening the
     * forum is a worse answer than opening the post, and a much better one than doing nothing.</p>
     */
    private resolveChannel(breadcrumb: InboxBreadcrumb, guild?: GuildDto): ChannelDto | undefined {
        const g = guild ?? this.guildService.guilds().find(x => x.id === breadcrumb.guildId);
        if (!g) return undefined;
        return g.channels.find(c => c.id === breadcrumb.channelId)
            ?? (breadcrumb.parentChannelId
                ? g.channels.find(c => c.id === breadcrumb.parentChannelId)
                : undefined);
    }

    private async toUnreadEntry(group: InboxUnreadGroup): Promise<InboxUnreadEntry> {
        return {
            breadcrumb: group.breadcrumb,
            lastActivityAt: group.lastActivityAt,
            unreadCount: group.unreadCount,
            mentionCount: group.mentionCount,
            previews: await this.decryptPreviews(group.previews, group.breadcrumb.channelId, null),
            previewsTruncated: group.previewsTruncated,
        };
    }

    private async toMentionEntry(mention: InboxMention): Promise<InboxMentionEntry> {
        const [preview] = await this.decryptPreviews(
            [mention.message],
            mention.breadcrumb?.channelId ?? null,
            mention.conversationId,
        );
        return {mention, preview};
    }

    /**
     * Runs inbox previews through the same decryptor channel history uses.
     *
     * <p>The server never decrypts, so an encrypted channel's preview arrives as ciphertext and
     * would render as base64 without this. Going through the shared path rather than a bespoke one
     * buys the plaintext cache (so opening the channel afterwards is a cache hit rather than a
     * second trip through a ratchet that only moves forward), the encryption-floor check that
     * refuses a server-declared cleartext body in a context this device has encrypted, and an
     * honest `undecryptable` for eras this device was never admitted to.</p>
     */
    private async decryptPreviews(
        messages: InboxMessage[],
        channelId: string | null,
        conversationId: string | null,
    ): Promise<InboxPreview[]> {
        const mapped = messages.map(m => this.toMessageDto(m, channelId, conversationId));
        const decrypted = await decryptMessages(
            mapped, this.mlsService, this.mlsSync, this.mlsHealth);
        this.primeAuthors(messages);
        return decrypted.map((message, i) => ({
            message,
            authorDisplayName: messages[i].authorDisplayName,
            authorAvatarUrl: messages[i].authorAvatarUrl,
        }));
    }

    /**
     * Warms the profile cache for preview authors the inbox is about to name.
     *
     * <p>`authorDisplayName` is only set for webhooks and bots, so an ordinary member's preview
     * carries a user id and nothing else. The cache is a signal, so filling it re-renders the rows
     * that were waiting on it - fire and forget is the whole mechanism. Bots and already-cached
     * authors cost nothing.</p>
     */
    private primeAuthors(messages: InboxMessage[]): void {
        const pending = new Set(messages
            .filter(m => !m.authorDisplayName && !this.profileService.getCachedByUserId(m.authorId))
            .map(m => m.authorId));
        for (const userId of pending) {
            this.profileService.getByUserId(userId).subscribe({error: () => undefined});
        }
    }

    /** An {@link InboxMessage} in the shape the shared decryptor and `readableContent` expect. */
    private toMessageDto(
        msg: InboxMessage,
        channelId: string | null,
        conversationId: string | null,
    ): MessageDto {
        const createdAt = new Date(msg.createdAt);
        return {
            id: msg.id,
            createdAt,
            updatedAt: createdAt,
            content: msg.content,
            channelId: channelId ?? undefined,
            conversationId: conversationId ?? undefined,
            authorId: msg.authorId,
            isPending: false,
            isFailed: false,
            attachments: [],
            inReplyTo: undefined,
            mentions: [],
            encryptionState: msg.isEncrypted
                ? MessageEncryptionState.Encrypted
                : MessageEncryptionState.Plain,
            mlsEpoch: undefined,
            mlsSequenceNumber: undefined,
            mlsGeneration: msg.mlsGeneration,
            senderDeviceId: undefined,
            // Indexed, not cast: the inbox's numbering is not the app enum's order.
            type: INBOX_MESSAGE_TYPES[msg.type] ?? MessageType.Message,
            embedsJson: msg.embedsJson ?? undefined,
            systemMessageVariant: msg.systemMessageVariant ?? undefined,
        };
    }

    /**
     * Moves the badge by a delta rather than refetching.
     *
     * <p>Clamped at zero, and left alone once `capped` - past the cap the reported number is
     * already a floor, and nudging it renders the same `99+` either way.</p>
     */
    private adjustSummary(channels: number, mentions: number): void {
        this._summary.update(s => s.capped ? s : {
            unreadChannelCount: Math.max(0, s.unreadChannelCount + channels),
            mentionCount: Math.max(0, s.mentionCount + mentions),
            capped: false,
        });
    }

    private previewRetryScheduled = false;

    /** One background retry for bodies the message service could not serve. Never a loop. */
    private retryPreviewsLater(): void {
        if (this.previewRetryScheduled) return;
        this.previewRetryScheduled = true;
        setTimeout(async () => {
            this.previewRetryScheduled = false;
            if (!this.previewsUnavailable()) return;
            try {
                const page = await firstValueFrom(this.api.unread(UNREAD_PAGE_SIZE, null));
                if (page.previewsUnavailable) return;
                const entries = await Promise.all(page.groups.map(g => this.toUnreadEntry(g)));
                // Only the first page is replaced; anything paged in beyond it keeps its rows and
                // gets bodies the next time the popout is opened.
                this._unread.update(list => [...entries, ...list.slice(entries.length)]);
                this.previewsUnavailable.set(false);
            } catch {
                // Left as unavailable. The next open tries again.
            }
        }, 5_000);
    }
}
