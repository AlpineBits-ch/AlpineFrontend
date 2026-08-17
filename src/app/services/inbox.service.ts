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
    InboxTask,
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
import {HouseholdAlertService} from './household-alert.service';

/** How many groups/mentions to ask for per page. Both are clamped server-side. */
const UNREAD_PAGE_SIZE = 10;
const MENTIONS_PAGE_SIZE = 25;

/**
 * How many empty-but-cursored pages one `loadMore` will chase before giving up. Filtering happens
 * after a page is taken, so an empty page with a live `nextCursor` means "keep going".
 */
const MAX_EMPTY_HOPS = 10;

/** How long a burst of channel reads settles before the badge is refetched. */
const READ_RESYNC_DEBOUNCE_MS = 2_000;

/** How many tasks to ask for. Server-clamped at 50. */
const TASKS_PAGE_SIZE = 25;

const EMPTY_SUMMARY: InboxSummary = {
    unreadChannelCount: 0,
    mentionCount: 0,
    taskCount: 0,
    capped: false,
};

/** A preview whose body could not be decoded, so the row still says something. */
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
 * Everything waiting for the user, from every guild and every DM at once. The sidebar's own
 * per-channel dots stay with {@link GuildReadStateService}.
 *
 * Two API rules run through everything here: ids are opaque, so nothing compares two of them and
 * `lastActivityAt`/`createdAt` order the lists; and paging stops on a null cursor, never on a
 * short or empty page.
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
    private householdAlerts = inject(HouseholdAlertService);

    // ── Unread tab ──────────────────────────────────────────────────────────
    private readonly _unread = signal<InboxUnreadEntry[]>([]);
    readonly unread = this._unread.asReadonly();
    private unreadCursor: string | null = null;
    readonly unreadLoading = signal(false);
    readonly unreadHasMore = signal(false);
    readonly unreadFailed = signal(false);

    /**
     * The message service could not be reached, so the rows carry no bodies. Groups, counts and
     * breadcrumbs come from another service and are still correct, so the tab renders without them.
     */
    readonly previewsUnavailable = signal(false);

    // ── Mentions tab ────────────────────────────────────────────────────────
    private readonly _mentions = signal<InboxMentionEntry[]>([]);
    readonly mentions = this._mentions.asReadonly();
    private mentionsCursor: string | null = null;
    readonly mentionsLoading = signal(false);
    readonly mentionsHasMore = signal(false);
    readonly mentionsFailed = signal(false);

    // ── Waiting-on-you tab ──────────────────────────────────────────────────
    private readonly _tasks = signal<InboxTask[]>([]);
    readonly tasks = this._tasks.asReadonly();
    readonly tasksLoading = signal(false);
    readonly tasksFailed = signal(false);
    /** More were waiting than the page returned. There is no cursor; it is a to-do list. */
    readonly tasksTruncated = signal(false);

    // ── Badge ───────────────────────────────────────────────────────────────
    private readonly _summary = signal<InboxSummary>(EMPTY_SUMMARY);
    readonly summary = this._summary.asReadonly();

    /**
     * What the titlebar badge draws, or null for no badge at all. `capped` means the server stopped
     * counting, so the numbers are a floor and render as `99+` whatever they add up to.
     */
    readonly badgeLabel = computed(() => {
        const {unreadChannelCount, mentionCount, taskCount, capped} = this._summary();
        // Tasks count too: a list channel holds no messages, so nothing else lights the badge for it.
        const total = unreadChannelCount + mentionCount + taskCount;
        if (total <= 0) return null;
        return capped || total > 99 ? '99+' : String(total);
    });

    /** Whether the last state the connection effect saw was `Connected`, so it can spot edges. */
    private wasConnected = false;

    constructor() {
        // Root singleton injected by the always-rendered titlebar, so this registers exactly once
        // at bootstrap. `on` is safe before `start`.
        this.realtime.on('inbox.MentionAdded', (d: InboxMentionAdded) => this.onMentionAdded(d));
        this.realtime.on('inbox.ReadStateChanged', (d: InboxReadStateChanged) => this.onReadStateChanged(d));

        // On the connected edge, not on `open`: it is the first moment there is a session to ask
        // about, and SignalR replays nothing it dropped, so a reconnect needs the same refetch.
        effect(() => {
            const connected = this.realtime.connectionState() === ConnectionState.Connected;
            if (connected === this.wasConnected) return;
            this.wasConnected = connected;
            if (connected) void this.refreshSummary();
        });

        // Refetched, never decremented: the local read state and the server's unread set are built
        // from different inputs, so arithmetic across them drifts.
        this.readState.channelRead$
            .pipe(debounceTime(READ_RESYNC_DEBOUNCE_MS), takeUntilDestroyed())
            .subscribe(() => void this.refreshSummary());

        // The one event that fills the Waiting-on-you tab without a message arriving:
        // `inbox.MentionAdded` never fires for a chore or a decision.
        this.householdAlerts.alerts$.pipe(takeUntilDestroyed()).subscribe(() => void this.refreshSummary());
    }

    // ── Loading ─────────────────────────────────────────────────────────────

    /**
     * Called when the popout is shown. Every open must start from the first page: the lists reorder
     * as messages arrive, so a keyset cursor held across a closed popout describes a stale list.
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
        void this.loadTasks();
    }

    /** The whole Waiting-on-you tab, in one request. Replaced, not appended; there is no cursor. */
    async loadTasks(): Promise<void> {
        if (this.tasksLoading()) return;
        this.tasksLoading.set(true);
        this.tasksFailed.set(false);
        try {
            const page = await firstValueFrom(this.api.tasks(TASKS_PAGE_SIZE));
            this._tasks.set(page.tasks);
            this.tasksTruncated.set(page.truncated);
        } catch {
            this.tasksFailed.set(true);
        } finally {
            this.tasksLoading.set(false);
        }
    }

    async loadMoreUnread(): Promise<void> {
        if (this.unreadLoading()) return;
        this.unreadLoading.set(true);
        this.unreadFailed.set(false);
        try {
            let hops = 0;
            // Keeps going while the server hands back an empty page with a live cursor. Never stop
            // on `groups.length === 0`.
            while (hops++ < MAX_EMPTY_HOPS) {
                const page = await firstValueFrom(this.api.unread(UNREAD_PAGE_SIZE, this.unreadCursor));
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
            // Deleted messages are skipped, so a page can be short or empty while more pages exist.
            while (hops++ < MAX_EMPTY_HOPS) {
                const page = await firstValueFrom(
                    this.api.mentions({
                        limit: MENTIONS_PAGE_SIZE,
                        cursor: this.mentionsCursor,
                    }),
                );
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

    /** The tick on an unread row. Optimistic; the sidebar's dot is cleared in the same gesture. */
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
        // The task count must survive: `read-all` marks messages read, and a due chore stays due.
        this._summary.set({...EMPTY_SUMMARY, taskCount: beforeSummary.taskCount});
        for (const entry of beforeUnread) this.readState.markChannelRead(entry.breadcrumb.channelId);

        try {
            await firstValueFrom(this.api.readAll());
        } catch {
            this._unread.set(beforeUnread);
            this._summary.set(beforeSummary);
        }
    }

    /**
     * The dismiss action on a mention row. `createdAt` must be passed straight through from the
     * server's row: the index is keyed on it, so a re-derived value deletes nothing and still 204s.
     */
    async dismissMention(entry: InboxMentionEntry): Promise<void> {
        const before = this._mentions();
        this._mentions.set(before.filter(e => e.mention.messageId !== entry.mention.messageId));
        this.adjustSummary(0, -1);

        try {
            await firstValueFrom(this.api.dismissMention(entry.mention.messageId, entry.mention.createdAt));
        } catch {
            this._mentions.set(before);
            this.adjustSummary(0, 1);
        }
    }

    /** Jumps to whatever an unread row points at, switching workspace first when it is elsewhere. */
    openUnread(entry: InboxUnreadEntry): void {
        this.openBreadcrumb(entry.breadcrumb);
    }

    /** Jumps to the board a task is waiting on, by breadcrumb so an unknown `kind` still opens. */
    openTask(task: InboxTask): void {
        this.openBreadcrumb(task.breadcrumb);
    }

    /** Jumps to whatever a mention points at: a guild channel, or the DM it arrived in. */
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
     * The glyph in front of a channel name. Resolved from the loaded guild, never from
     * `breadcrumb.channelType`: that field is numeric while {@link ChannelType} is a string enum.
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
     * A new mention arrived. Bumps the badge from the event; the list is left alone because the
     * payload carries no message body or breadcrumb.
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
            // Tasks are untouched by a read-all from any device: they are not messages.
            this._summary.update(s => ({...EMPTY_SUMMARY, taskCount: s.taskCount}));
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
     * The loaded `ChannelDto` behind a breadcrumb. Threads and forum posts are not always in
     * `guild.channels`, so a missing one falls back to the parent the breadcrumb names.
     */
    private resolveChannel(breadcrumb: InboxBreadcrumb, guild?: GuildDto): ChannelDto | undefined {
        const g = guild ?? this.guildService.guilds().find(x => x.id === breadcrumb.guildId);
        if (!g) return undefined;
        return (
            g.channels.find(c => c.id === breadcrumb.channelId) ??
            (breadcrumb.parentChannelId
                ? g.channels.find(c => c.id === breadcrumb.parentChannelId)
                : undefined)
        );
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
     * Runs inbox previews through the same decryptor channel history uses. Must stay on the shared
     * path: it carries the plaintext cache (the ratchet only moves forward), the encryption-floor
     * check, and an honest `undecryptable` for eras this device was never admitted to.
     */
    private async decryptPreviews(
        messages: InboxMessage[],
        channelId: string | null,
        conversationId: string | null,
    ): Promise<InboxPreview[]> {
        const mapped = messages.map(m => this.toMessageDto(m, channelId, conversationId));
        const decrypted = await decryptMessages(mapped, this.mlsService, this.mlsSync, this.mlsHealth);
        this.primeAuthors(messages);
        return decrypted.map((message, i) => ({
            message,
            authorDisplayName: messages[i].authorDisplayName,
            authorAvatarUrl: messages[i].authorAvatarUrl,
        }));
    }

    /**
     * Warms the profile cache for preview authors. `authorDisplayName` is only set for webhooks
     * and bots; the cache is a signal, so filling it re-renders the waiting rows.
     */
    private primeAuthors(messages: InboxMessage[]): void {
        const pending = new Set(
            messages
                .filter(m => !m.authorDisplayName && !this.profileService.getCachedByUserId(m.authorId))
                .map(m => m.authorId),
        );
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

    /** Moves the badge by a delta. Clamped at zero, and left alone once `capped`. */
    private adjustSummary(channels: number, mentions: number): void {
        this._summary.update(s =>
            s.capped
                ? s
                : {
                      unreadChannelCount: Math.max(0, s.unreadChannelCount + channels),
                      mentionCount: Math.max(0, s.mentionCount + mentions),
                      // Untouched: nothing on the message side completes a chore or casts a vote.
                      taskCount: s.taskCount,
                      capped: false,
                  },
        );
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
