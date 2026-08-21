import {inject} from '@angular/core';
import {patchState, signalStore, withHooks, withMethods, withState} from '@ngrx/signals';
import {
    addEntities,
    removeEntities,
    removeEntity,
    updateEntity,
    upsertEntities,
    upsertEntity,
    withEntities,
} from '@ngrx/signals/entities';
import {MessageDto, MessageFlags, MessageReaction} from '../dtos/response/message.dto';
import {MessageEncryptionState} from '../enums/message-encryption-state.enum';
import {MessagingService} from '../services/messaging.service';
import {MlsReplayedMessage, MlsService} from '../services/mls.service';
import {MlsSyncService} from '../services/mls-sync.service';
import {MlsHealthService} from '../services/mls-health.service';
import {
    MessageDeletedEvent,
    MessagePinnedEvent,
    MessageUnpinnedEvent,
    MessageUpdatedEvent,
    MessagingWebsocketService,
    ReactionEvent,
} from '../services/messaging-websocket.service';
import {GuildWebsocketService} from '../services/guild-websocket.service';
import {RealtimeConnectionService} from '../services/realtime-connection.service';
import {ProfileService} from '../services/profile.service';
import {HttpErrorResponse} from '@angular/common/http';
import {catchError, firstValueFrom, from, Observable, of, switchMap, tap} from 'rxjs';
import {fromBase64} from '../helpers/base64.helper';
import {decryptMessages} from '../helpers/message-decrypt';
import {MessageCacheService, messageContextKey} from '../services/cache/message-cache.service';

const PAGE_SIZE = 30;

interface ConversationMeta {
    offset: number;
    hasMore: boolean;
    loadingMore: boolean;
    error?: number;

    // ── Anchored windows ────────────────────────────────────────────────────
    // An ordinary window grows backwards from the newest message and has one edge. Reading a
    // scene from its first post needs the other edge too, so the view can stop short of the
    // present instead of jumping to it.
    /** Seeded by a cursor rather than by the newest page. `offset` means nothing while set. */
    anchored?: boolean;
    /** Newer messages exist beyond the window. Only meaningful while anchored. */
    hasNewer?: boolean;
    loadingNewer?: boolean;
    /**
     * The newest message the window reaches, as `createdAt` plus its id. Anything past it is held
     * but not shown: putting turn 47 under turn 3 is the failure this exists to prevent.
     */
    windowEndAt?: string;
    windowEndId?: string;
}

/** Total order on a channel's backlog, matching the server's `(created_at, message_id)` ordering. */
function isAfter(at: string, id: string, endAt: string, endId: string): boolean {
    const a = new Date(at).getTime();
    const b = new Date(endAt).getTime();
    if (a !== b) return a > b;
    return id > endId;
}

/**
 * Whether a message falls inside the window as it currently stands. Everything is inside an
 * unanchored window, which is what makes this free for every ordinary channel.
 */
export function withinWindow(
    meta: {anchored?: boolean; windowEndAt?: string; windowEndId?: string} | undefined,
    message: {id: string; createdAt: string | Date},
): boolean {
    if (!meta?.anchored || !meta.windowEndAt || !meta.windowEndId) return true;
    const at = message.createdAt instanceof Date ? message.createdAt.toISOString() : message.createdAt;
    return !isAfter(at, message.id, meta.windowEndAt, meta.windowEndId);
}

/** The far end of a page, in the same total order. */
function newestOf(messages: MessageDto[]): {at: string; id: string} | null {
    let best: {at: string; id: string} | null = null;
    for (const message of messages) {
        const at =
            message.createdAt instanceof Date ? message.createdAt.toISOString() : String(message.createdAt);
        if (!best || isAfter(at, message.id, best.at, best.id)) best = {at, id: message.id};
    }
    return best;
}

interface SearchEntry {
    query: string;
    results: MessageDto[];
    searching: boolean;
}

interface MessageState {
    conversationMeta: Record<string, ConversationMeta>;
    searchEntries: Record<string, SearchEntry>;
    channelMeta: Record<string, ConversationMeta>;
    channelSearchEntries: Record<string, SearchEntry>;
}

function decodeContent(encoded: string): string {
    try {
        const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    } catch {
        return '';
    }
}

function messageMatchesQuery(msg: MessageDto, q: string): boolean {
    // An unverified body is not searchable: a hit discloses content this device will not vouch for.
    if (!msg.undecryptable && decodeContent(msg.content).toLowerCase().includes(q)) return true;
    return msg.attachments.some(a => a.fileName.toLowerCase().includes(q));
}

/** Custom-emoji and unicode reactions never match each other, even with identical display text. */
function reactionMatches(r: MessageReaction, event: ReactionEvent): boolean {
    return event.emojiId
        ? r.emojiId === event.emojiId && r.userId === event.userId
        : r.emoji === event.emoji && !r.emojiId && r.userId === event.userId;
}

/** Never union cached ids back in: the server page is authoritative, and `cached` is one load's paint alone. */
export function reconcile(cached: MessageDto[], fromServer: MessageDto[]): MessageDto[] {
    return fromServer;
}

export const MessageStore = signalStore(
    {providedIn: 'root'},
    withEntities<MessageDto>(),
    withState<MessageState>({
        conversationMeta: {},
        searchEntries: {},
        channelMeta: {},
        channelSearchEntries: {},
    }),

    withMethods(
        (
            store,
            messagingService = inject(MessagingService),
            mlsService = inject(MlsService),
            mlsSync = inject(MlsSyncService),
            mlsHealth = inject(MlsHealthService),
            messageCache = inject(MessageCacheService),
        ) => {
            // Ids one `loadFor*` call painted from the cache: bookkeeping for one in-flight load,
            // never store state and never widened to the full entity map. See `reconcile`.
            const conversationCachePaint = new Map<string, MessageDto[]>();
            const channelCachePaint = new Map<string, MessageDto[]>();

            return {
                loadForConversation(conversationId: string): void {
                    // Already fetched, so nothing to do
                    if (store.conversationMeta()[conversationId]) return;

                    // Optimistically mark as loading so concurrent calls don't double-fetch
                    patchState(store, {
                        conversationMeta: {
                            ...store.conversationMeta(),
                            [conversationId]: {offset: 0, hasMore: true, loadingMore: true},
                        },
                    });

                    // Painted first, replaced on arrival. `offset` is a server-side cursor and never moves here.
                    void messageCache
                        .recall(messageContextKey({conversationId}))
                        .then(cached => {
                            if (cached.length === 0) return;
                            if (!store.conversationMeta()[conversationId]?.loadingMore) return;
                            return decryptMessages(cached, mlsService, mlsSync, mlsHealth).then(decrypted => {
                                // Re-checked before the commit: a slow cache read must never overwrite
                                // fresher server data.
                                if (!store.conversationMeta()[conversationId]?.loadingMore) return;

                                // Only ids this paint adds: a websocket message that raced in is fresher
                                // than the cache and is not an eviction candidate.
                                const existingIds = new Set(store.entities().map(m => m.id));
                                const painted = decrypted.filter(m => !existingIds.has(m.id));
                                if (painted.length === 0) return;

                                conversationCachePaint.set(conversationId, painted);
                                patchState(store, addEntities(painted));
                            });
                        })
                        // A cache failure must stay silent: the network fetch below is the source of truth.
                        .catch(() => {});

                    messagingService
                        .getMessagesForConversation(conversationId, 0, PAGE_SIZE)
                        .pipe(
                            switchMap(messages =>
                                from(decryptMessages(messages, mlsService, mlsSync, mlsHealth)),
                            ),
                        )
                        .subscribe({
                            next: messages => {
                                // Exactly the ids this load painted, never every entity the store holds.
                                const painted = conversationCachePaint.get(conversationId) ?? [];
                                conversationCachePaint.delete(conversationId);

                                const settled = reconcile(painted, messages);
                                const dropped = painted
                                    .filter(c => !settled.some(s => s.id === c.id))
                                    .map(c => c.id);

                                // Scoped to the painted ids alone: an id that arrived by any other route
                                // must keep `addEntities`'s no-op-on-existing, or this page clobbers it.
                                const paintedIds = new Set(painted.map(m => m.id));
                                const confirmedFromCache = messages.filter(m => paintedIds.has(m.id));
                                const fromNetworkOnly = messages.filter(m => !paintedIds.has(m.id));

                                patchState(
                                    store,
                                    removeEntities(dropped),
                                    addEntities(fromNetworkOnly),
                                    upsertEntities(confirmedFromCache),
                                    {
                                        conversationMeta: {
                                            ...store.conversationMeta(),
                                            [conversationId]: {
                                                offset: messages.length,
                                                hasMore: messages.length === PAGE_SIZE,
                                                loadingMore: false,
                                            },
                                        },
                                    },
                                );
                                // Caught, not discarded: a loose rejection reaches `GlobalErrorHandler`,
                                // which reloads the window after three in five seconds.
                                void messageCache
                                    .remember(messageContextKey({conversationId}), messages)
                                    .catch((err: unknown) =>
                                        console.debug('Conversation page not cached', err),
                                    );
                            },
                            error: (err: HttpErrorResponse) => {
                                conversationCachePaint.delete(conversationId);
                                patchState(store, {
                                    conversationMeta: {
                                        ...store.conversationMeta(),
                                        [conversationId]: {
                                            offset: 0,
                                            hasMore: false,
                                            loadingMore: false,
                                            error: err.status || 0,
                                        },
                                    },
                                });
                            },
                        });
                },

                loadMoreForConversation(conversationId: string): void {
                    const meta = store.conversationMeta()[conversationId];
                    if (!meta || meta.loadingMore || !meta.hasMore) return;

                    patchState(store, {
                        conversationMeta: {
                            ...store.conversationMeta(),
                            [conversationId]: {...meta, loadingMore: true},
                        },
                    });

                    messagingService
                        .getMessagesForConversation(conversationId, meta.offset, PAGE_SIZE)
                        .pipe(
                            switchMap(messages =>
                                from(decryptMessages(messages, mlsService, mlsSync, mlsHealth)),
                            ),
                        )
                        .subscribe({
                            next: messages => {
                                patchState(store, addEntities(messages), {
                                    conversationMeta: {
                                        ...store.conversationMeta(),
                                        [conversationId]: {
                                            offset: meta.offset + messages.length,
                                            hasMore: messages.length === PAGE_SIZE,
                                            loadingMore: false,
                                        },
                                    },
                                });
                            },
                            error: () => {
                                patchState(store, {
                                    conversationMeta: {
                                        ...store.conversationMeta(),
                                        [conversationId]: {...meta, loadingMore: false},
                                    },
                                });
                            },
                        });
                },

                clearConversationError(conversationId: string): void {
                    const meta = {...store.conversationMeta()};
                    delete meta[conversationId];
                    patchState(store, {conversationMeta: meta});
                },

                addMessage(msg: MessageDto): void {
                    patchState(store, upsertEntity(msg));
                },

                /** Removed and re-inserted, not updated: `updateEntity` keeps the temp key and duplicates the message. */
                confirmMessage(tempId: string, confirmed: MessageDto): void {
                    // Annotated so `isPending: false` widens to boolean; upsertEntity rejects the literal.
                    const settled: MessageDto = {...confirmed, isPending: false, isFailed: false};
                    patchState(store, removeEntity(tempId), upsertEntity(settled));
                },

                /** Mark a pending message as failed */
                failMessage(tempId: string): void {
                    patchState(
                        store,
                        updateEntity({id: tempId, changes: {isPending: false, isFailed: true}}),
                    );
                },

                removeMessage(id: string): void {
                    patchState(store, removeEntity(id));
                },

                applyReactionAdded(event: ReactionEvent): void {
                    const msg = store.entityMap()[event.messageId];
                    if (!msg) return;
                    const reactions = msg.reactions ?? [];
                    if (reactions.some(r => reactionMatches(r, event))) return;
                    const entry: MessageReaction = {
                        contextId: event.conversationId ?? event.channelId ?? '',
                        messageId: event.messageId,
                        emoji: event.emoji,
                        emojiId: event.emojiId ?? null,
                        userId: event.userId,
                        createdAt: new Date().toISOString(),
                        conversationId: event.conversationId ?? null,
                        channelId: event.channelId ?? null,
                    };
                    patchState(
                        store,
                        updateEntity({id: event.messageId, changes: {reactions: [...reactions, entry]}}),
                    );
                },

                applyReactionRemoved(event: ReactionEvent): void {
                    const msg = store.entityMap()[event.messageId];
                    if (!msg) return;
                    const reactions = (msg.reactions ?? []).filter(r => !reactionMatches(r, event));
                    patchState(store, updateEntity({id: event.messageId, changes: {reactions}}));
                },

                applyPinned(event: MessagePinnedEvent): void {
                    patchState(
                        store,
                        updateEntity({
                            id: event.messageId,
                            changes: {isPinned: true, pinnedAt: event.pinnedAt, pinnedById: event.pinnedById},
                        }),
                    );
                },

                applyUnpinned(event: MessageUnpinnedEvent): void {
                    patchState(
                        store,
                        updateEntity({
                            id: event.messageId,
                            changes: {isPinned: false, pinnedAt: undefined, pinnedById: undefined},
                        }),
                    );
                },

                /** Only the named message changes: the event exists so a client on the parent channel can redraw one row. */
                attachThread(messageId: string, threadId: string): void {
                    const held = store.entityMap()[messageId];
                    if (!held) return;
                    patchState(
                        store,
                        updateEntity({
                            id: messageId,
                            changes: {threadId, flags: (held.flags ?? 0) | MessageFlags.HasThread},
                        }),
                    );
                },

                applyMessageUpdate(dto: MessageDto): void {
                    patchState(store, updateEntity({id: dto.id, changes: dto}));
                },

                /** Judged from the stored message's encryption state: the one field the server cannot rewrite. */
                async applyRemoteUpdate(event: MessageUpdatedEvent): Promise<void> {
                    const existing = store.entityMap()[event.messageId];
                    // An edit for a message we have never seen carries no context to judge it against.
                    if (!existing) return;

                    // Everything but the body, applied on every path below including the refusing one.
                    const metadata: Partial<MessageDto> = {
                        ...(event.embedsJson !== undefined
                            ? {embedsJson: event.embedsJson ?? undefined}
                            : {}),
                        ...(event.flags !== undefined ? {flags: event.flags} : {}),
                        ...(event.editedAt !== undefined ? {editedAt: event.editedAt} : {}),
                    };

                    // A preview attaching is not an edit: MLS ratchets forward only, so re-decrypting the
                    // same ciphertext fails and blanks a message that rendered fine.
                    if (event.isAuthorEdit === false) {
                        patchState(
                            store,
                            updateEntity({
                                id: event.messageId,
                                changes: {...metadata, updatedAt: new Date()},
                            }),
                        );
                        return;
                    }

                    const contextId = existing.conversationId ?? existing.channelId;
                    if (existing.encryptionState !== MessageEncryptionState.Encrypted || !contextId) {
                        patchState(
                            store,
                            updateEntity({
                                id: event.messageId,
                                changes: {...metadata, content: event.content, updatedAt: new Date()},
                            }),
                        );
                        return;
                    }

                    const isChannel = !!existing.channelId;
                    const generation =
                        existing.mlsGeneration ?? (await mlsService.getKnownGeneration(contextId));
                    const groupId =
                        generation === null || generation === undefined
                            ? null
                            : await mlsService.getGroupId(contextId, generation);

                    const plaintext = groupId
                        ? await mlsSync.decryptMessage(
                              contextId,
                              isChannel,
                              groupId,
                              fromBase64(event.content),
                              event.messageId,
                              existing.authorId,
                          )
                        : null;

                    if (!plaintext) {
                        // Refused, not rendered: an edit we cannot authenticate must never appear as the
                        // author's words.
                        mlsHealth.recordFailure(contextId, isChannel, 'decrypt-failed');
                        patchState(
                            store,
                            updateEntity({
                                id: event.messageId,
                                changes: {...metadata, undecryptable: true, updatedAt: new Date()},
                            }),
                        );
                        return;
                    }

                    void mlsService.cacheMessage(
                        contextId,
                        generation ?? null,
                        event.messageId,
                        plaintext,
                        existing.authorId,
                    );
                    patchState(
                        store,
                        updateEntity({
                            id: event.messageId,
                            changes: {
                                ...metadata,
                                content: plaintext,
                                undecryptable: false,
                                updatedAt: new Date(),
                            },
                        }),
                    );
                },

                /** Restoring only clears the flag; the card itself returns over `*.MessageUpdated`. */
                applyEmbedSuppression(messageId: string, suppressed: boolean, embedsJson?: string): void {
                    const existing = store.entityMap()[messageId];
                    if (!existing) return;
                    const flags = suppressed
                        ? (existing.flags ?? 0) | MessageFlags.SuppressEmbeds
                        : (existing.flags ?? 0) & ~MessageFlags.SuppressEmbeds;
                    patchState(
                        store,
                        updateEntity({
                            id: messageId,
                            changes: {flags, embedsJson: suppressed ? undefined : embedsJson},
                        }),
                    );
                },

                /** MLS decrypts from the wire exactly once, so a replayed message not applied here is lost for good. */
                async applyReplayedMessages(
                    contextId: string,
                    messages: readonly MlsReplayedMessage[],
                ): Promise<void> {
                    const generation = await mlsService.getKnownGeneration(contextId);

                    for (const replayed of messages) {
                        if (!replayed.messageId) continue;
                        const existing = store.entityMap()[replayed.messageId];

                        // The signing credential against the row the server attributed it to, the binding a
                        // replay would otherwise skip.
                        if (
                            existing &&
                            replayed.senderIdentity &&
                            existing.authorId !== replayed.senderIdentity
                        ) {
                            mlsHealth.recordFailure(
                                contextId,
                                !!existing.channelId,
                                'decrypt-failed',
                                `the server attributed replayed message ${replayed.messageId} to ` +
                                    `${existing.authorId}, but it was signed by ${replayed.senderIdentity}`,
                            );
                            continue;
                        }

                        void mlsService.cacheMessage(
                            contextId,
                            generation,
                            replayed.messageId,
                            replayed.plaintext,
                            existing?.authorId ?? replayed.senderIdentity ?? undefined,
                        );

                        if (!existing) continue;
                        patchState(
                            store,
                            updateEntity({
                                id: replayed.messageId,
                                changes: {content: replayed.plaintext, undecryptable: false},
                            }),
                        );
                    }
                },

                removeMessagesForConversation(conversationId: string): void {
                    const ids = store
                        .entities()
                        .filter(m => m.conversationId === conversationId)
                        .map(m => m.id);
                    const meta = {...store.conversationMeta()};
                    delete meta[conversationId];
                    patchState(store, removeEntities(ids), {conversationMeta: meta});
                },

                searchInConversation(conversationId: string, query: string): void {
                    const q = query.trim().toLowerCase();
                    if (!q) {
                        const entries = {...store.searchEntries()};
                        delete entries[conversationId];
                        patchState(store, {searchEntries: entries});
                        return;
                    }

                    const localResults = store
                        .entities()
                        .filter(m => m.conversationId === conversationId && !m.isPending && !m.isFailed)
                        .filter(m => messageMatchesQuery(m, q));

                    const meta = store.conversationMeta()[conversationId];
                    const needsRemote = meta?.hasMore ?? true;

                    patchState(store, {
                        searchEntries: {
                            ...store.searchEntries(),
                            [conversationId]: {query: q, results: localResults, searching: needsRemote},
                        },
                    });

                    if (!needsRemote) return;

                    messagingService.searchMessagesForConversation(conversationId, q).subscribe({
                        next: remoteResults => {
                            patchState(store, addEntities(remoteResults));
                            const localIds = new Set(localResults.map(m => m.id));
                            const merged = [
                                ...localResults,
                                ...remoteResults.filter(r => !localIds.has(r.id)),
                            ].sort(
                                (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
                            );
                            patchState(store, {
                                searchEntries: {
                                    ...store.searchEntries(),
                                    [conversationId]: {query: q, results: merged, searching: false},
                                },
                            });
                        },
                        error: () => {
                            patchState(store, {
                                searchEntries: {
                                    ...store.searchEntries(),
                                    [conversationId]: {
                                        ...store.searchEntries()[conversationId],
                                        searching: false,
                                    },
                                },
                            });
                        },
                    });
                },

                clearSearch(conversationId: string): void {
                    const entries = {...store.searchEntries()};
                    delete entries[conversationId];
                    patchState(store, {searchEntries: entries});
                },

                loadForChannel(channelId: string): void {
                    if (store.channelMeta()[channelId]) return;
                    patchState(store, {
                        channelMeta: {
                            ...store.channelMeta(),
                            [channelId]: {offset: 0, hasMore: true, loadingMore: true},
                        },
                    });

                    // Same treatment as `loadForConversation`; see the comments there.
                    void messageCache
                        .recall(messageContextKey({channelId}))
                        .then(cached => {
                            if (cached.length === 0) return;
                            if (!store.channelMeta()[channelId]?.loadingMore) return;
                            return decryptMessages(cached, mlsService, mlsSync, mlsHealth).then(decrypted => {
                                if (!store.channelMeta()[channelId]?.loadingMore) return;

                                const existingIds = new Set(store.entities().map(m => m.id));
                                const painted = decrypted.filter(m => !existingIds.has(m.id));
                                if (painted.length === 0) return;

                                channelCachePaint.set(channelId, painted);
                                patchState(store, addEntities(painted));
                            });
                        })
                        // A cache failure here must stay silent, exactly as in `loadForConversation`.
                        .catch(() => {});

                    messagingService
                        .getMessagesForChannel(channelId, 0, PAGE_SIZE)
                        .pipe(
                            switchMap(messages =>
                                from(decryptMessages(messages, mlsService, mlsSync, mlsHealth)),
                            ),
                        )
                        .subscribe({
                            next: messages => {
                                const painted = channelCachePaint.get(channelId) ?? [];
                                channelCachePaint.delete(channelId);

                                const settled = reconcile(painted, messages);
                                const dropped = painted
                                    .filter(c => !settled.some(s => s.id === c.id))
                                    .map(c => c.id);

                                // Scoped to the painted ids alone; see `loadForConversation`.
                                const paintedIds = new Set(painted.map(m => m.id));
                                const confirmedFromCache = messages.filter(m => paintedIds.has(m.id));
                                const fromNetworkOnly = messages.filter(m => !paintedIds.has(m.id));

                                patchState(
                                    store,
                                    removeEntities(dropped),
                                    addEntities(fromNetworkOnly),
                                    upsertEntities(confirmedFromCache),
                                    {
                                        channelMeta: {
                                            ...store.channelMeta(),
                                            [channelId]: {
                                                offset: messages.length,
                                                hasMore: messages.length === PAGE_SIZE,
                                                loadingMore: false,
                                            },
                                        },
                                    },
                                );
                                // Swallowed: an unavailable cache must never reach the global error handler.
                                void messageCache
                                    .remember(messageContextKey({channelId}), messages)
                                    .catch((err: unknown) => console.debug('Channel page not cached', err));
                            },
                            error: (err: HttpErrorResponse) => {
                                channelCachePaint.delete(channelId);
                                patchState(store, {
                                    channelMeta: {
                                        ...store.channelMeta(),
                                        [channelId]: {
                                            offset: 0,
                                            hasMore: false,
                                            loadingMore: false,
                                            error: err.status || 0,
                                        },
                                    },
                                });
                            },
                        });
                },

                /**
                 * Seeds a window at the channel's first message instead of its last. Never painted
                 * from the cache: the cache holds the newest page, which is the opposite end.
                 */
                loadChannelOldest(channelId: string): void {
                    const meta = store.channelMeta()[channelId];
                    if (meta?.loadingMore || meta?.loadingNewer) return;

                    patchState(store, {
                        channelMeta: {
                            ...store.channelMeta(),
                            [channelId]: {
                                offset: 0,
                                // Nothing is older than the beginning.
                                hasMore: false,
                                loadingMore: true,
                                anchored: true,
                                hasNewer: true,
                            },
                        },
                    });

                    messagingService
                        .getMessagesForChannel(channelId, 0, PAGE_SIZE, {oldest: true})
                        .pipe(
                            switchMap(messages =>
                                from(decryptMessages(messages, mlsService, mlsSync, mlsHealth)),
                            ),
                        )
                        .subscribe({
                            next: messages => {
                                const end = newestOf(messages);
                                patchState(store, addEntities(messages), {
                                    channelMeta: {
                                        ...store.channelMeta(),
                                        [channelId]: {
                                            offset: 0,
                                            hasMore: false,
                                            loadingMore: false,
                                            anchored: true,
                                            hasNewer: messages.length === PAGE_SIZE,
                                            windowEndAt: end?.at,
                                            windowEndId: end?.id,
                                        },
                                    },
                                });
                            },
                            error: (err: HttpErrorResponse) => {
                                patchState(store, {
                                    channelMeta: {
                                        ...store.channelMeta(),
                                        [channelId]: {
                                            offset: 0,
                                            hasMore: false,
                                            loadingMore: false,
                                            error: err.status || 0,
                                        },
                                    },
                                });
                            },
                        });
                },

                /** Widens an anchored window forward, toward the present. */
                loadNewerForChannel(channelId: string): void {
                    const meta = store.channelMeta()[channelId];
                    if (!meta?.anchored || meta.loadingNewer || !meta.hasNewer || !meta.windowEndId) return;

                    patchState(store, {
                        channelMeta: {
                            ...store.channelMeta(),
                            [channelId]: {...meta, loadingNewer: true},
                        },
                    });

                    messagingService
                        .getMessagesForChannel(channelId, 0, PAGE_SIZE, {after: meta.windowEndId})
                        .pipe(
                            switchMap(messages =>
                                from(decryptMessages(messages, mlsService, mlsSync, mlsHealth)),
                            ),
                        )
                        .subscribe({
                            next: messages => {
                                const held = store.channelMeta()[channelId] ?? meta;
                                const end = newestOf(messages);
                                patchState(store, addEntities(messages), {
                                    channelMeta: {
                                        ...store.channelMeta(),
                                        [channelId]: {
                                            ...held,
                                            loadingNewer: false,
                                            hasNewer: messages.length === PAGE_SIZE,
                                            windowEndAt: end?.at ?? held.windowEndAt,
                                            windowEndId: end?.id ?? held.windowEndId,
                                        },
                                    },
                                });
                            },
                            error: () => {
                                const held = store.channelMeta()[channelId] ?? meta;
                                patchState(store, {
                                    channelMeta: {
                                        ...store.channelMeta(),
                                        [channelId]: {...held, loadingNewer: false},
                                    },
                                });
                            },
                        });
                },

                /**
                 * Drops the far edge and puts the channel back at the present. The meta entry goes
                 * with it so `loadForChannel` reads the newest page again; the messages already
                 * loaded stay, so the history read so far is not thrown away.
                 */
                clearChannelAnchor(channelId: string): void {
                    const meta = store.channelMeta()[channelId];
                    if (!meta?.anchored) return;

                    const next = {...store.channelMeta()};
                    delete next[channelId];
                    patchState(store, {channelMeta: next});
                },

                loadMoreForChannel(channelId: string): void {
                    const meta = store.channelMeta()[channelId];
                    if (!meta || meta.loadingMore || !meta.hasMore) return;
                    patchState(store, {
                        channelMeta: {
                            ...store.channelMeta(),
                            [channelId]: {...meta, loadingMore: true},
                        },
                    });
                    messagingService
                        .getMessagesForChannel(channelId, meta.offset, PAGE_SIZE)
                        .pipe(
                            switchMap(messages =>
                                from(decryptMessages(messages, mlsService, mlsSync, mlsHealth)),
                            ),
                        )
                        .subscribe({
                            next: messages => {
                                patchState(store, addEntities(messages), {
                                    channelMeta: {
                                        ...store.channelMeta(),
                                        [channelId]: {
                                            offset: meta.offset + messages.length,
                                            hasMore: messages.length === PAGE_SIZE,
                                            loadingMore: false,
                                        },
                                    },
                                });
                            },
                            error: () => {
                                patchState(store, {
                                    channelMeta: {
                                        ...store.channelMeta(),
                                        [channelId]: {...meta, loadingMore: false},
                                    },
                                });
                            },
                        });
                },

                clearChannelError(channelId: string): void {
                    const meta = {...store.channelMeta()};
                    delete meta[channelId];
                    patchState(store, {channelMeta: meta});
                },

                removeMessagesForChannel(channelId: string): void {
                    const ids = store
                        .entities()
                        .filter(m => m.channelId === channelId)
                        .map(m => m.id);
                    const meta = {...store.channelMeta()};
                    delete meta[channelId];
                    patchState(store, removeEntities(ids), {channelMeta: meta});
                },

                searchInChannel(channelId: string, query: string): void {
                    const q = query.trim().toLowerCase();
                    if (!q) {
                        const entries = {...store.channelSearchEntries()};
                        delete entries[channelId];
                        patchState(store, {channelSearchEntries: entries});
                        return;
                    }
                    const localResults = store
                        .entities()
                        .filter(m => m.channelId === channelId && !m.isPending && !m.isFailed)
                        .filter(m => messageMatchesQuery(m, q));
                    const meta = store.channelMeta()[channelId];
                    const needsRemote = meta?.hasMore ?? true;
                    patchState(store, {
                        channelSearchEntries: {
                            ...store.channelSearchEntries(),
                            [channelId]: {query: q, results: localResults, searching: needsRemote},
                        },
                    });
                    if (!needsRemote) return;
                    messagingService.searchMessagesForChannel(channelId, q).subscribe({
                        next: remoteResults => {
                            patchState(store, addEntities(remoteResults));
                            const localIds = new Set(localResults.map(m => m.id));
                            const merged = [
                                ...localResults,
                                ...remoteResults.filter(r => !localIds.has(r.id)),
                            ].sort(
                                (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
                            );
                            patchState(store, {
                                channelSearchEntries: {
                                    ...store.channelSearchEntries(),
                                    [channelId]: {query: q, results: merged, searching: false},
                                },
                            });
                        },
                        error: () => {
                            patchState(store, {
                                channelSearchEntries: {
                                    ...store.channelSearchEntries(),
                                    [channelId]: {
                                        ...store.channelSearchEntries()[channelId],
                                        searching: false,
                                    },
                                },
                            });
                        },
                    });
                },

                clearChannelSearch(channelId: string): void {
                    const entries = {...store.channelSearchEntries()};
                    delete entries[channelId];
                    patchState(store, {channelSearchEntries: entries});
                },

                getOrFetchMessage(
                    messageId: string,
                    context: {
                        conversationId?: string;
                        channelId?: string;
                    },
                ): Observable<MessageDto | null> {
                    const existing = store.entityMap()[messageId];
                    if (existing) return of(existing);
                    return messagingService.getMessageById({messageId, ...context}).pipe(
                        tap(msg => patchState(store, upsertEntity(msg))),
                        catchError(() => of(null)),
                    );
                },
            };
        },
    ),

    withHooks({
        onInit(store) {
            const wsService = inject(MessagingWebsocketService);
            const guildWsService = inject(GuildWebsocketService);
            const realtime = inject(RealtimeConnectionService);
            const profileService = inject(ProfileService);
            const mlsSync = inject(MlsSyncService);

            // MLS decrypts from the wire exactly once, so an unconsumed drain loses the message.
            mlsSync.replayedMessages.subscribe(
                ({contextId, messages}) => void store.applyReplayedMessages(contextId, messages),
            );

            wsService.messageObservable.subscribe(msg => patchState(store, upsertEntity(msg)));

            guildWsService.messageObservable.subscribe(msg => patchState(store, upsertEntity(msg)));

            // Routed through the decryptor rather than written straight in - see applyRemoteUpdate.
            wsService.messageUpdatedObservable.subscribe(
                (event: MessageUpdatedEvent) => void store.applyRemoteUpdate(event),
            );

            // Channel edits through the identical path, so the stored encryption state decides here too.
            guildWsService.messageUpdatedObservable.subscribe(
                (event: MessageUpdatedEvent) => void store.applyRemoteUpdate(event),
            );

            // A guild message deleted by somebody else. Without this it stays on screen until reload.
            realtime
                .stream('guild.MessageDeleted')
                .subscribe(event => patchState(store, removeEntity(event.messageId)));

            // One patch, not one per id: `removeEntity` in a loop re-renders the list every time.
            realtime
                .stream('guild.MessagesBulkDeleted')
                .subscribe(event => patchState(store, removeEntities(event.messageIds)));

            // Ephemeral bot replies, never counted into `channelMeta.offset`: it is a history cursor.
            guildWsService.ephemeralMessageObservable.subscribe(msg => patchState(store, upsertEntity(msg)));

            wsService.messageDeletedObservable.subscribe((event: MessageDeletedEvent) =>
                patchState(store, removeEntity(event.messageId)),
            );

            wsService.conversationRemovedObservable.subscribe(event => {
                const ids = store
                    .entities()
                    .filter(m => m.conversationId === event.conversationId)
                    .map(m => m.id);
                const meta = {...store.conversationMeta()};
                delete meta[event.conversationId];
                patchState(store, removeEntities(ids), {conversationMeta: meta});
            });

            wsService.conversationMemberRemovedObservable.subscribe(event => {
                if (event.userId !== profileService.ownProfile()?.userId) return;
                const ids = store
                    .entities()
                    .filter(m => m.conversationId === event.conversationId)
                    .map(m => m.id);
                const meta = {...store.conversationMeta()};
                delete meta[event.conversationId];
                patchState(store, removeEntities(ids), {conversationMeta: meta});
            });

            wsService.reactionAddedObservable.subscribe(event => store.applyReactionAdded(event));
            wsService.reactionRemovedObservable.subscribe(event => store.applyReactionRemoved(event));
            realtime.stream('guild.ReactionCreated').subscribe(event => store.applyReactionAdded(event));
            realtime.stream('guild.ReactionRemoved').subscribe(event => store.applyReactionRemoved(event));

            wsService.messagePinnedObservable.subscribe(event => store.applyPinned(event));
            wsService.messageUnpinnedObservable.subscribe(event => store.applyUnpinned(event));
            realtime.stream('guild.MessagePinned').subscribe(event => store.applyPinned(event));
            realtime.stream('guild.MessageUnpinned').subscribe(event => store.applyUnpinned(event));
        },
    }),
);
