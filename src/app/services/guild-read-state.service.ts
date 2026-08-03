import {inject, Injectable, signal, untracked} from '@angular/core';
import {firstValueFrom, Observable, Subject} from 'rxjs';
import {GuildWebsocketService} from './guild-websocket.service';
import {NavigationService} from '../features/main-page/navigation.service';
import {InboxApiService} from './inbox-api.service';
import {InboxUnreadPage} from '../dtos/response/inbox.dto';
import {ProfileService} from './profile.service';

export interface ChannelReadState {
    isUnread: boolean;
    mentionCount: number;
}

/** Pages of unread groups one seed will walk before giving up. 25 channels each. */
const MAX_SEED_PAGES = 40;

@Injectable({providedIn: 'root'})
export class GuildReadStateService {
    private guildWs = inject(GuildWebsocketService);
    private navService = inject(NavigationService);
    private inboxApi = inject(InboxApiService);
    private profileService = inject(ProfileService);

    private seeded = false;
    private _channelStates = signal<Record<string, ChannelReadState>>({});
    readonly channelStates = this._channelStates.asReadonly();

    private readonly _channelRead = new Subject<string>();

    /**
     * A channel just went from unread to read, anywhere in the app.
     *
     * <p>Exists for the titlebar badge. That badge counts unread channels, and the two ways a
     * channel goes quiet - opening it, and Mark as read on a server - both land here and nowhere
     * the inbox can see, so without this the badge kept counting channels the user had just read
     * and only corrected itself on the next reconnect.</p>
     *
     * <p><b>Only real transitions are emitted.</b> Scrolling a channel re-marks it read on every
     * new message, and the server-taskbar's Mark as read walks every channel in a guild whether or
     * not it was unread; a subscriber refetching on each of those would be answering a question
     * whose answer cannot have changed.</p>
     */
    readonly channelRead$: Observable<string> = this._channelRead.asObservable();

    constructor() {
        this.guildWs.messageObservable.subscribe(msg => {
            if (!msg.channelId) return;
            const view = this.navService.mainView();
            const isActive = view.type === 'channel' && view.channel.id === msg.channelId;
            if (!isActive) {
                const ownId = this.profileService.ownProfile()?.userId;
                const mentionIncrement = ownId && (msg.mentions ?? []).includes(ownId) ? 1 : 0;
                this._markUnread(msg.channelId, mentionIncrement);
            }
        });
    }

    /**
     * Fills in what was already unread before this session started.
     *
     * <p><b>This used to read `member.readState[].mentionCount` off `getOwnMember`, and that field
     * is now always `0`.</b> The server stopped keeping it the moment an `@everyone` became one row
     * instead of one row per member - there is no per-user write left to increment, and the stored
     * counter was never idempotent anyway (a retried message doubled it, a deleted one left it high
     * forever). It still deserializes, so nothing broke loudly; the sidebar simply drew no badges
     * and no dots until a message arrived live. `isUnread` was derived from the same field, so the
     * whole seed was dead, not just the counts.</p>
     *
     * <p>The inbox is now the only surface that answers "what was unread before I opened the app",
     * so the seed comes from there. One walk covers every guild, replacing the request per guild
     * this used to cost.</p>
     *
     * <p><b>Muted channels are not in it.</b> The endpoint omits muted channels, categories and
     * guilds, channels set to notify `Nothing`, and channels the caller can no longer see - so a
     * muted channel now starts the session with no dot and lights up only if a message arrives
     * while the app is open. There is no other endpoint that would answer otherwise.</p>
     */
    async ensureSeeded(): Promise<void> {
        if (this.seeded) return;
        this.seeded = true;
        try {
            let cursor: string | null = null;
            let pages = 0;
            do {
                const inboxPage: InboxUnreadPage =
                    await firstValueFrom(this.inboxApi.unread(25, cursor));
                this._channelStates.update(states => {
                    const next = {...states};
                    for (const group of inboxPage.groups) {
                        const id = group.breadcrumb.channelId;
                        // Never clobbers a live state: a message that arrived while this was in
                        // flight is fresher than the page it raced.
                        if (!next[id]) {
                            next[id] = {isUnread: true, mentionCount: group.mentionCount};
                        }
                    }
                    return next;
                });
                // Muting and permission filtering are applied after the page is taken, so an empty
                // page with a live cursor means "keep going". Only a null cursor ends this.
                cursor = inboxPage.nextCursor;
            } while (cursor !== null && ++pages < MAX_SEED_PAGES);
        } catch {
            // Left unseeded so the next guild switch tries again rather than the sidebar staying
            // blank for the whole session.
            this.seeded = false;
        }
    }

    /**
     * <p><b>Both guards below are load-bearing, and neither is a micro-optimisation.</b> The channel
     * view calls this from inside an `effect` on every change to the open channel's messages, so
     * this method body runs in a reactive context.</p>
     *
     * <p>The read is `untracked` because a tracked one makes `_channelStates` a dependency of that
     * effect, which the write on the next line then dirties - the effect re-runs, writes again, and
     * never settles. Effects have no cycle detection (only `computed` does), so that loop throws
     * nothing and logs nothing; it just pins a core and fires a `guild.UpdateLastRead` per turn
     * until the renderer runs out of memory.</p>
     *
     * <p>The early return is the second half: `update` hands back a fresh object every call, and
     * `Object.is` equality means that counts as a change even when the state is identical. Without
     * it, re-marking an already-read channel still notifies every `channelStates()` reader - the
     * whole sidebar - on each arriving message.</p>
     */
    markChannelRead(channelId: string): void {
        const current = untracked(this._channelStates)[channelId];
        if (current && !current.isUnread && current.mentionCount === 0) return;
        this._channelStates.update(s => ({...s, [channelId]: {isUnread: false, mentionCount: 0}}));
        if (current?.isUnread) this._channelRead.next(channelId);
    }

    getChannelState(channelId: string): ChannelReadState {
        return this._channelStates()[channelId] ?? {isUnread: false, mentionCount: 0};
    }

    /**
     * One read state standing for a channel and its children. A forum carries no messages
     * of its own - every message lives in one of its posts - so read straight off its own
     * id it is permanently silent, and the row could never report activity inside it.
     */
    aggregate(channelIds: readonly string[]): ChannelReadState {
        const states = this._channelStates();
        let isUnread = false;
        let mentionCount = 0;
        for (const id of channelIds) {
            const state = states[id];
            if (!state) continue;
            isUnread ||= state.isUnread;
            mentionCount += state.mentionCount;
        }
        return {isUnread, mentionCount};
    }

    hasAnyUnread(channelIds: string[]): boolean {
        const states = this._channelStates();
        return channelIds.some(id => states[id]?.isUnread ?? false);
    }

    private _markUnread(channelId: string, mentionIncrement: number = 0): void {
        this._channelStates.update(s => ({
            ...s,
            [channelId]: {
                isUnread: true,
                mentionCount: (s[channelId]?.mentionCount ?? 0) + mentionIncrement,
            },
        }));
    }
}
