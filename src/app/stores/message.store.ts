import {inject} from '@angular/core';
import {patchState, signalStore, withHooks, withMethods, withState} from '@ngrx/signals';
import {
    addEntities,
    removeEntities,
    removeEntity,
    updateEntity,
    upsertEntity,
    withEntities
} from '@ngrx/signals/entities';
import {MessageDto, MessageReaction} from '../dtos/response/message.dto';
import {MessageEncryptionState} from '../enums/message-encryption-state.enum';
import {MessageType} from '../enums/message-type.enum';
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
    ReactionEvent
} from '../services/messaging-websocket.service';
import {GuildWebsocketService} from '../services/guild-websocket.service';
import {ProfileService} from '../services/profile.service';
import {HttpErrorResponse} from '@angular/common/http';
import {catchError, firstValueFrom, from, Observable, of, switchMap, tap} from 'rxjs';
import {fromBase64} from "../helpers/base64.helper";

const PAGE_SIZE = 30;

interface ConversationMeta {
    offset: number;
    hasMore: boolean;
    loadingMore: boolean;
    error?: number;
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
    // An unverified body is not searchable. It is not shown, so matching on it would only surface
    // the message in a result list - and "the search found your word in it" is itself a
    // disclosure about content this device has refused to vouch for.
    if (!msg.undecryptable && decodeContent(msg.content).toLowerCase().includes(q)) return true;
    return msg.attachments.some(a => a.fileName.toLowerCase().includes(q));
}

/**
 * A reaction event matches a stored reaction when they refer to the same custom emoji
 * (by emojiId) or, if the event has no emojiId, the same unicode/text emoji -but never
 * across the two: a custom-emoji reaction and a unicode reaction that happen to share
 * display text must never be treated as the same reaction.
 */
function reactionMatches(r: MessageReaction, event: ReactionEvent): boolean {
    return event.emojiId
        ? r.emojiId === event.emojiId && r.userId === event.userId
        : r.emoji === event.emoji && !r.emojiId && r.userId === event.userId;
}

/**
 * Turns stored ciphertext back into readable content where it can.
 *
 * The plaintext cache is not an optimisation, it is the only way most of this succeeds. MLS ratchets
 * forward and never backward, so a message can be decrypted from the wire exactly once, on the
 * device that was in the group at the time. Paging back through history therefore reads from the
 * cache or not at all - `undecryptable` is set so the UI can say so plainly instead of rendering
 * base64 at the user.
 */
async function decryptMessages(
    messages: MessageDto[],
    mlsService: MlsService,
    mlsSync: MlsSyncService,
    health: MlsHealthService,
): Promise<MessageDto[]> {
    const result: MessageDto[] = [];
    for (const msg of messages) {
        const contextId = msg.conversationId ?? msg.channelId;
        if (!contextId) {
            result.push(msg);
            continue;
        }

        const isChannel = !!msg.channelId;

        if (msg.encryptionState !== MessageEncryptionState.Encrypted) {
            // `encryptionState` is a per-message server field, and skipping the decryptor on it
            // rendered `content` verbatim under `authorId` - arbitrary text in an end-to-end
            // encrypted thread, attributed to a real member, needing no group keys at all. §L.9
            // forbids exactly this, and `applyRemoteUpdate` already got it right by deciding from
            // the *stored* state. The equivalent local fact on the read paths is the monotonic
            // encryption floor: above it, a message claiming to be cleartext is untrusted, not
            // content.
            //
            // System messages are exempt because they carry no author-attributed body - they are
            // rendered from `type` and a variant index, not from `content`.
            if (msg.type !== MessageType.System
                && await mlsService.getEncryptionFloor(contextId) !== null) {
                health.recordFailure(
                    contextId, isChannel, 'downgraded',
                    `message ${msg.id} claims to be unencrypted in a context this device has `
                    + `encrypted`);
                result.push({...msg, undecryptable: true});
                continue;
            }
            result.push(msg);
            continue;
        }

        if (msg.type === MessageType.System) {
            result.push(msg);
            continue;
        }

        // The message names the era it was sealed under. Falling back to whichever group we
        // currently hold would decrypt against the wrong keys once a context has been toggled off
        // and on, producing silent garbage instead of an honest failure.
        const generation = msg.mlsGeneration ?? await mlsService.getKnownGeneration(contextId);

        // Keyed on context and generation as well as the id, and checked against the author the
        // server is claiming right now. `msg.id` is the server's to choose: on the bare id alone,
        // an id replayed from another conversation returned that conversation's plaintext here,
        // and on this path the lookup happens before the group is even resolved - so the reader
        // need not be a member of the context the id came from.
        const cached = await mlsService.getCachedMessage(
            contextId, generation ?? null, msg.id, msg.authorId);
        if (cached) {
            result.push({...msg, content: cached});
            continue;
        }

        const groupId = generation === null || generation === undefined
            ? null
            : await mlsService.getGroupId(contextId, generation);

        if (!groupId) {
            // Distinct from a decrypt failure: this device was never admitted to the era the
            // message belongs to, which is a state the user can act on by re-linking.
            health.recordFailure(contextId, isChannel, 'not-admitted');
            result.push({...msg, undecryptable: true});
            continue;
        }

        // Through the sync service: history paging used to call the engine directly, so a decrypt
        // could interleave between the stage and the merge of a two-phase commit for the same
        // group. It also carries the roster check, which had no call sites at all before this.
        const plaintext = await mlsSync.decryptMessage(
            contextId, isChannel, groupId, fromBase64(msg.content), msg.id, msg.authorId,
        );

        if (plaintext) {
            void mlsService.cacheMessage(
                contextId, generation ?? null, msg.id, plaintext, msg.authorId);
            result.push({...msg, content: plaintext});
            continue;
        }

        // Ordinary when paging past the ratchet's reach, and permanent when it happens: MLS
        // decrypts from the wire exactly once. `undecryptable` is what lets the UI say so rather
        // than rendering base64 at the reader.
        result.push({...msg, undecryptable: true});
    }
    return result;
}

export const MessageStore = signalStore(
    {providedIn: 'root'},
    withEntities<MessageDto>(),
    withState<MessageState>({conversationMeta: {}, searchEntries: {}, channelMeta: {}, channelSearchEntries: {}}),

    withMethods((store, messagingService = inject(MessagingService), mlsService = inject(MlsService), mlsSync = inject(MlsSyncService), mlsHealth = inject(MlsHealthService)) => ({
        loadForConversation(conversationId: string): void {
            // Already fetched -no-op
            if (store.conversationMeta()[conversationId]) return;

            // Optimistically mark as loading so concurrent calls don't double-fetch
            patchState(store, {
                conversationMeta: {
                    ...store.conversationMeta(),
                    [conversationId]: {offset: 0, hasMore: true, loadingMore: true},
                },
            });

            messagingService
                .getMessagesForConversation(conversationId, 0, PAGE_SIZE)
                .pipe(switchMap(messages => from(decryptMessages(messages, mlsService, mlsSync, mlsHealth))))
                .subscribe({
                    next: messages => {
                        patchState(store, addEntities(messages), {
                            conversationMeta: {
                                ...store.conversationMeta(),
                                [conversationId]: {
                                    offset: messages.length,
                                    hasMore: messages.length === PAGE_SIZE,
                                    loadingMore: false,
                                },
                            },
                        });
                    },
                    error: (err: HttpErrorResponse) => {
                        patchState(store, {
                            conversationMeta: {
                                ...store.conversationMeta(),
                                [conversationId]: {
                                    offset: 0,
                                    hasMore: false,
                                    loadingMore: false,
                                    error: err.status || 0
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
                .pipe(switchMap(messages => from(decryptMessages(messages, mlsService, mlsSync, mlsHealth))))
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

        /** Replace a pending (optimistic) message with the confirmed server response */
        confirmMessage(tempId: string, confirmed: MessageDto): void {
            patchState(store, updateEntity({id: tempId, changes: {...confirmed, isPending: false, isFailed: false}}));
        },

        /** Mark a pending message as failed */
        failMessage(tempId: string): void {
            patchState(store, updateEntity({id: tempId, changes: {isPending: false, isFailed: true}}));
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
            patchState(store, updateEntity({id: event.messageId, changes: {reactions: [...reactions, entry]}}));
        },

        applyReactionRemoved(event: ReactionEvent): void {
            const msg = store.entityMap()[event.messageId];
            if (!msg) return;
            const reactions = (msg.reactions ?? []).filter(r => !reactionMatches(r, event));
            patchState(store, updateEntity({id: event.messageId, changes: {reactions}}));
        },

        applyPinned(event: MessagePinnedEvent): void {
            patchState(store, updateEntity({
                id: event.messageId,
                changes: {isPinned: true, pinnedAt: event.pinnedAt, pinnedById: event.pinnedById},
            }));
        },

        applyUnpinned(event: MessageUnpinnedEvent): void {
            patchState(store, updateEntity({
                id: event.messageId,
                changes: {isPinned: false, pinnedAt: undefined, pinnedById: undefined},
            }));
        },

        applyMessageUpdate(dto: MessageDto): void {
            patchState(store, updateEntity({id: dto.id, changes: dto}));
        },

        /**
         * Applies an edit announced over the socket.
         *
         * <p>The content on this event is a server-supplied string. Writing it straight into the
         * store - which is what used to happen - lets anyone able to emit the event put arbitrary
         * text into an end-to-end encrypted thread, attributed to the original author, with nothing
         * to indicate it never came from them. That is the entire confidentiality claim gone, and
         * it needs no group keys at all.</p>
         *
         * <p>The decision is made from the **stored** message's encryption state rather than
         * anything on the event: the local copy is the one field the server cannot rewrite in
         * flight.</p>
         */
        async applyRemoteUpdate(event: MessageUpdatedEvent): Promise<void> {
            const existing = store.entityMap()[event.messageId];
            // An edit for a message we have never seen carries no context to judge it against.
            if (!existing) return;

            const contextId = existing.conversationId ?? existing.channelId;
            if (existing.encryptionState !== MessageEncryptionState.Encrypted || !contextId) {
                patchState(store, updateEntity({
                    id: event.messageId,
                    changes: {content: event.content, updatedAt: new Date()},
                }));
                return;
            }

            const isChannel = !!existing.channelId;
            const generation = existing.mlsGeneration
                ?? await mlsService.getKnownGeneration(contextId);
            const groupId = generation === null || generation === undefined
                ? null
                : await mlsService.getGroupId(contextId, generation);

            const plaintext = groupId
                ? await mlsSync.decryptMessage(
                    contextId, isChannel, groupId, fromBase64(event.content), event.messageId,
                    existing.authorId)
                : null;

            if (!plaintext) {
                // Refused, not rendered. An edit we cannot authenticate is indistinguishable from
                // an injected one, so it must never appear as the author's words.
                mlsHealth.recordFailure(contextId, isChannel, 'decrypt-failed');
                patchState(store, updateEntity({
                    id: event.messageId,
                    changes: {undecryptable: true, updatedAt: new Date()},
                }));
                return;
            }

            void mlsService.cacheMessage(
                contextId, generation ?? null, event.messageId, plaintext, existing.authorId);
            patchState(store, updateEntity({
                id: event.messageId,
                changes: {content: plaintext, undecryptable: false, updatedAt: new Date()},
            }));
        },

        /**
         * Applies a message that arrived before the commit that made it readable.
         *
         * <p><b>Nothing consumed `replayedMessages` at all.</b> `drain_pending_messages` *removes*
         * each buffered entry, decrypts it, and returns only the still-pending ones to the buffer -
         * and MLS decrypts from the wire exactly once, so every message that raced ahead of its
         * commit was decrypted and then dropped on the floor. Permanently, and precisely the loss
         * the buffer exists to prevent: not draining at all would have been strictly safer than
         * draining into nothing.</p>
         *
         * <p>Upserted by id and cached, so a copy that was already rendered as undecryptable
         * becomes readable and stays readable across a reload.</p>
         */
        async applyReplayedMessages(
            contextId: string,
            messages: readonly MlsReplayedMessage[],
        ): Promise<void> {
            const generation = await mlsService.getKnownGeneration(contextId);

            for (const replayed of messages) {
                if (!replayed.messageId) continue;
                const existing = store.entityMap()[replayed.messageId];

                // The credential that actually signed it against the row the server attributed it
                // to - the same binding `decryptMessage` applies, which a replay would otherwise
                // skip because it never goes back through that path.
                if (existing && replayed.senderIdentity
                    && existing.authorId !== replayed.senderIdentity) {
                    mlsHealth.recordFailure(
                        contextId, !!existing.channelId, 'decrypt-failed',
                        `the server attributed replayed message ${replayed.messageId} to `
                        + `${existing.authorId}, but it was signed by ${replayed.senderIdentity}`);
                    continue;
                }

                void mlsService.cacheMessage(
                    contextId, generation, replayed.messageId, replayed.plaintext,
                    existing?.authorId ?? replayed.senderIdentity ?? undefined);

                if (!existing) continue;
                patchState(store, updateEntity({
                    id: replayed.messageId,
                    changes: {content: replayed.plaintext, undecryptable: false},
                }));
            }
        },

        removeMessagesForConversation(conversationId: string): void {
            const ids = store.entities()
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

            const localResults = store.entities()
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
                    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
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
                            [conversationId]: {...store.searchEntries()[conversationId], searching: false},
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
            messagingService
                .getMessagesForChannel(channelId, 0, PAGE_SIZE)
                .pipe(switchMap(messages => from(decryptMessages(messages, mlsService, mlsSync, mlsHealth))))
                .subscribe({
                    next: messages => {
                        patchState(store, addEntities(messages), {
                            channelMeta: {
                                ...store.channelMeta(),
                                [channelId]: {
                                    offset: messages.length,
                                    hasMore: messages.length === PAGE_SIZE,
                                    loadingMore: false,
                                },
                            },
                        });
                    },
                    error: (err: HttpErrorResponse) => {
                        patchState(store, {
                            channelMeta: {
                                ...store.channelMeta(),
                                [channelId]: {offset: 0, hasMore: false, loadingMore: false, error: err.status || 0},
                            },
                        });
                    },
                });
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
                .pipe(switchMap(messages => from(decryptMessages(messages, mlsService, mlsSync, mlsHealth))))
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
            const ids = store.entities()
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
            const localResults = store.entities()
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
                    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
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
                            [channelId]: {...store.channelSearchEntries()[channelId], searching: false},
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

        getOrFetchMessage(messageId: string, context: {
            conversationId?: string;
            channelId?: string
        }): Observable<MessageDto | null> {
            const existing = store.entityMap()[messageId];
            if (existing) return of(existing);
            return messagingService.getMessageById({messageId, ...context}).pipe(
                tap(msg => patchState(store, upsertEntity(msg))),
                catchError(() => of(null)),
            );
        },
    })),

    withHooks({
        onInit(store) {
            const wsService = inject(MessagingWebsocketService);
            const guildWsService = inject(GuildWebsocketService);
            const profileService = inject(ProfileService);
            const mlsSync = inject(MlsSyncService);

            // The subscriber `MlsSyncService.replayedMessages` never had. Without one, every
            // message that arrived ahead of its commit was decrypted by the drain and discarded -
            // MLS decrypts from the wire exactly once, so those were gone for good.
            mlsSync.replayedMessages.subscribe(({contextId, messages}) =>
                void store.applyReplayedMessages(contextId, messages)
            );

            wsService.messageObservable.subscribe(msg =>
                patchState(store, upsertEntity(msg))
            );

            guildWsService.messageObservable.subscribe(msg =>
                patchState(store, upsertEntity(msg))
            );

            // Routed through the decryptor rather than written straight in - see applyRemoteUpdate.
            wsService.messageUpdatedObservable.subscribe((event: MessageUpdatedEvent) =>
                void store.applyRemoteUpdate(event)
            );

            wsService.messageDeletedObservable.subscribe((event: MessageDeletedEvent) =>
                patchState(store, removeEntity(event.messageId))
            );

            wsService.conversationRemovedObservable.subscribe(event => {
                const ids = store.entities()
                    .filter(m => m.conversationId === event.conversationId)
                    .map(m => m.id);
                const meta = {...store.conversationMeta()};
                delete meta[event.conversationId];
                patchState(store, removeEntities(ids), {conversationMeta: meta});
            });

            wsService.conversationMemberRemovedObservable.subscribe(event => {
                if (event.userId !== profileService.ownProfile()?.userId) return;
                const ids = store.entities()
                    .filter(m => m.conversationId === event.conversationId)
                    .map(m => m.id);
                const meta = {...store.conversationMeta()};
                delete meta[event.conversationId];
                patchState(store, removeEntities(ids), {conversationMeta: meta});
            });

            wsService.reactionAddedObservable.subscribe(event => store.applyReactionAdded(event));
            wsService.reactionRemovedObservable.subscribe(event => store.applyReactionRemoved(event));
            guildWsService.reactionAddedObservable.subscribe(event => store.applyReactionAdded(event));
            guildWsService.reactionRemovedObservable.subscribe(event => store.applyReactionRemoved(event));

            wsService.messagePinnedObservable.subscribe(event => store.applyPinned(event));
            wsService.messageUnpinnedObservable.subscribe(event => store.applyUnpinned(event));
            guildWsService.messagePinnedObservable.subscribe(event => store.applyPinned(event));
            guildWsService.messageUnpinnedObservable.subscribe(event => store.applyUnpinned(event));
        },
    })
);
