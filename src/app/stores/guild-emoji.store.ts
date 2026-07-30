import {inject} from '@angular/core';
import {patchState, signalStore, withHooks, withMethods, withState} from '@ngrx/signals';
import {GuildEmojiService} from '../services/guild-emoji.service';
import {GuildEmojiDto} from '../dtos/response/guild-emoji.dto';
import {GuildWebsocketService, WsEmojiCreated, WsEmojiDeleted} from '../services/guild-websocket.service';

// Presigned imageUrl expires ~1h server-side - revalidate a bit before that so a stale
// URL is never handed to the UI.
const STALE_MS = 55 * 60 * 1000;

interface GuildEmojiEntry {
    emojis: GuildEmojiDto[];
    fetchedAt: number;
    loading: boolean;
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
            const isStale = !entry || (Date.now() - entry.fetchedAt) > STALE_MS;
            if (!isStale || entry?.loading) return;

            patchState(store, {
                byGuild: {
                    ...store.byGuild(),
                    [guildId]: {emojis: entry?.emojis ?? [], fetchedAt: entry?.fetchedAt ?? 0, loading: true},
                },
            });

            guildEmojiService.getEmojis(guildId).subscribe({
                next: emojis => patchState(store, {
                    byGuild: {...store.byGuild(), [guildId]: {emojis, fetchedAt: Date.now(), loading: false}},
                }),
                error: () => patchState(store, {
                    byGuild: {
                        ...store.byGuild(),
                        [guildId]: {emojis: entry?.emojis ?? [], fetchedAt: entry?.fetchedAt ?? 0, loading: false},
                    },
                }),
            });
        },

        addEmoji(guildId: string, emoji: GuildEmojiDto): void {
            const entry = store.byGuild()[guildId];
            if (!entry) return;
            patchState(store, {byGuild: {...store.byGuild(), [guildId]: {...entry, emojis: [...entry.emojis, emoji]}}});
        },

        removeEmoji(guildId: string, emojiId: string): void {
            const entry = store.byGuild()[guildId];
            if (!entry) return;
            patchState(store, {
                byGuild: {...store.byGuild(), [guildId]: {...entry, emojis: entry.emojis.filter(e => e.id !== emojiId)}},
            });
        },

        invalidate(guildId: string): void {
            const entry = store.byGuild()[guildId];
            if (!entry) return;
            patchState(store, {byGuild: {...store.byGuild(), [guildId]: {...entry, fetchedAt: 0}}});
        },
    })),

    withHooks({
        onInit(store) {
            const guildWs = inject(GuildWebsocketService);

            // The realtime payload doesn't carry a presigned imageUrl, so a straight
            // addEmoji() isn't enough - invalidate and let ensureLoaded() pull the
            // full record (with a usable imageUrl) on next read.
            guildWs.emojiCreatedObservable.subscribe((e: WsEmojiCreated) => {
                store.invalidate(e.guildId);
                store.ensureLoaded(e.guildId);
            });

            guildWs.emojiDeletedObservable.subscribe((e: WsEmojiDeleted) => {
                store.removeEmoji(e.guildId, e.emojiId);
            });
        },
    }),
);
