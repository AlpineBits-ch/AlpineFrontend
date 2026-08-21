import {inject} from '@angular/core';
import {patchState, signalStore, withHooks, withMethods, withState} from '@ngrx/signals';
import {GuildEmojiService} from '../services/guild-emoji.service';
import {GuildEmojiDto} from '../dtos/response/guild-emoji.dto';
import {WsEmojiCreated, WsEmojiDeleted} from '../dtos/response/guild-events.dto';
import {RealtimeConnectionService} from '../services/realtime-connection.service';

// Presigned imageUrl expires ~1h server-side; revalidate before that so no stale URL reaches the UI.
const STALE_MS = 55 * 60 * 1000;

interface GuildEmojiEntry {
    emojis: GuildEmojiDto[];
    fetchedAt: number;
    loading: boolean;
    requestId: number;
}

interface GuildEmojiState {
    byGuild: Record<string, GuildEmojiEntry>;
}

export const GuildEmojiStore = signalStore(
    {providedIn: 'root'},
    withState<GuildEmojiState>({byGuild: {}}),

    withMethods((store, guildEmojiService = inject(GuildEmojiService)) => ({
        getEmojis(guildId: string): GuildEmojiDto[] {
            return store.byGuild()[guildId]?.emojis ?? [];
        },

        ensureLoaded(guildId: string): void {
            const entry = store.byGuild()[guildId];
            const isStale = !entry || Date.now() - entry.fetchedAt > STALE_MS;
            // The loading guard makes ensureLoaded() re-entrancy-safe; invalidate() clears it so a fetch can supersede.
            if (!isStale || entry?.loading) return;

            const requestId = (entry?.requestId ?? 0) + 1;

            patchState(store, {
                byGuild: {
                    ...store.byGuild(),
                    [guildId]: {
                        emojis: entry?.emojis ?? [],
                        fetchedAt: entry?.fetchedAt ?? 0,
                        loading: true,
                        requestId,
                    },
                },
            });

            guildEmojiService.getEmojis(guildId).subscribe({
                next: emojis => {
                    const current = store.byGuild()[guildId];
                    if (current?.requestId !== requestId) return;
                    patchState(store, {
                        byGuild: {
                            ...store.byGuild(),
                            [guildId]: {emojis, fetchedAt: Date.now(), loading: false, requestId},
                        },
                    });
                },
                error: () => {
                    const current = store.byGuild()[guildId];
                    if (current?.requestId !== requestId) return;
                    patchState(store, {
                        byGuild: {
                            ...store.byGuild(),
                            [guildId]: {
                                emojis: current.emojis,
                                fetchedAt: current.fetchedAt,
                                loading: false,
                                requestId,
                            },
                        },
                    });
                },
            });
        },

        addEmoji(guildId: string, emoji: GuildEmojiDto): void {
            const entry = store.byGuild()[guildId];
            if (!entry) return;
            patchState(store, {
                byGuild: {...store.byGuild(), [guildId]: {...entry, emojis: [...entry.emojis, emoji]}},
            });
        },

        removeEmoji(guildId: string, emojiId: string): void {
            const entry = store.byGuild()[guildId];
            if (!entry) return;
            patchState(store, {
                byGuild: {
                    ...store.byGuild(),
                    [guildId]: {...entry, emojis: entry.emojis.filter(e => e.id !== emojiId)},
                },
            });
        },

        invalidate(guildId: string): void {
            const entry = store.byGuild()[guildId];
            if (!entry) return;
            // Bumping requestId supersedes any in-flight fetch; clearing loading lets the next ensureLoaded() run.
            patchState(store, {
                byGuild: {
                    ...store.byGuild(),
                    [guildId]: {...entry, fetchedAt: 0, loading: false, requestId: entry.requestId + 1},
                },
            });
        },
    })),

    withHooks({
        onInit(store) {
            const realtime = inject(RealtimeConnectionService);

            // The realtime payload carries no presigned imageUrl, so addEmoji() alone is not enough.
            realtime.stream('guild.EmojiCreated').subscribe((e: WsEmojiCreated) => {
                store.invalidate(e.guildId);
                store.ensureLoaded(e.guildId);
            });

            realtime.stream('guild.EmojiDeleted').subscribe((e: WsEmojiDeleted) => {
                store.removeEmoji(e.guildId, e.emojiId);
            });
        },
    }),
);
