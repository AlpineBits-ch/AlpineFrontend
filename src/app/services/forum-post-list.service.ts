import {inject, Injectable, signal} from '@angular/core';
import {TranslateService} from '@ngx-translate/core';
import {ForumPost, ForumSortOrder} from '../dtos/response/forum.dto';
import {ForumService} from './forum.service';
import {ForumStateService} from './forum-state.service';
import {GuildWebsocketService} from './guild-websocket.service';
import {ToastService} from './toast.service';

const PAGE_SIZE = 25;

/** Everything a rendered post list needs; one of these per forum the user has opened. */
export interface ForumPostListState {
    posts: ForumPost[];
    loading: boolean;
    loadingMore: boolean;
    nextCursor: string | null;
    selectedTagIds: string[];
    showArchived: boolean;
}

/**
 * Handed out for forums nobody has opened. Shared and frozen: it is a read-only answer
 * to "what would this forum look like", never a working copy - every mutation spreads
 * it into a fresh object instead.
 */
const EMPTY_STATE: ForumPostListState = Object.freeze({
    posts: Object.freeze([] as ForumPost[]) as ForumPost[],
    loading: false,
    loadingMore: false,
    nextCursor: null,
    selectedTagIds: Object.freeze([] as string[]) as string[],
    showArchived: false,
});

/**
 * The paginated, filtered post list of each forum, held outside the components that draw
 * it. The full-width forum view and the narrow post-list pane are two mount points onto
 * the same list, and only one of them is alive at a time - keeping the list here is what
 * lets opening a post swap them without refetching or flashing a spinner over a list the
 * user was mid-read of.
 *
 * State is keyed by forum id and kept for the session, so realtime events subscribe once
 * here rather than per component. Tags and config are not duplicated - those live in
 * ForumStateService.
 */
@Injectable({providedIn: 'root'})
export class ForumPostListService {
    private readonly stateByForum = signal<Record<string, ForumPostListState>>({});

    /**
     * Bumped per forum on every reload. The component's guard could compare the response's
     * forum against the one on screen; a service serving every forum at once can't, so a
     * response carries the generation it was issued under and loses if that has moved on.
     */
    private readonly generationByForum = new Map<string, number>();

    private forumService = inject(ForumService);
    private forumState = inject(ForumStateService);
    private ws = inject(GuildWebsocketService);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);

    constructor() {
        this.ws.threadCreatedObservable.subscribe(e => {
            if (!this.stateByForum()[e.parentChannelId]) return;
            // A new post can land anywhere in the current filter/sort, and the cursor
            // can't express "insert here" - a reload from page one is the only way to
            // place it correctly without desynchronizing pagination.
            this.reload(e.parentChannelId);
        });

        this.ws.threadUpdatedObservable.subscribe(e => this.applyThreadUpdate(e.parentChannelId, e.channelId, e));

        // A deleted tag isn't accompanied by per-post updates, so strip it locally.
        this.ws.forumTagDeletedObservable.subscribe(e => {
            const state = this.stateByForum()[e.channelId];
            if (!state) return;
            this.updateLoaded(e.channelId, s => ({
                ...s,
                posts: s.posts.map(p => ({...p, tagIds: p.tagIds.filter(id => id !== e.tagId)})),
            }));
            if (state.selectedTagIds.includes(e.tagId)) {
                this.patch(e.channelId, {selectedTagIds: state.selectedTagIds.filter(id => id !== e.tagId)});
                this.reload(e.channelId);
            }
        });
    }

    /**
     * Never null. A forum nobody has opened reads as the empty default without gaining an
     * entry - creating one on read would make "has this forum been opened?" untrue, and
     * realtime events would start applying to a list that was never fetched.
     */
    stateFor(forumId: string): ForumPostListState {
        return this.stateByForum()[forumId] ?? EMPTY_STATE;
    }

    // ── Loading ──────────────────────────────────────────────────────────────
    reload(forumId: string): void {
        const generation = (this.generationByForum.get(forumId) ?? 0) + 1;
        this.generationByForum.set(forumId, generation);
        // loadingMore is cleared too: any append still in flight belongs to the list being
        // thrown away, and its response will be dropped as stale, so nothing else would.
        this.patch(forumId, {loading: true, loadingMore: false, nextCursor: null});
        this.fetch(forumId, generation, undefined, (state, page) => ({...state, posts: page, loading: false}));
    }

    loadMore(forumId: string): void {
        const state = this.stateFor(forumId);
        const cursor = state.nextCursor;
        if (!cursor || state.loadingMore || state.loading) return;
        this.patch(forumId, {loadingMore: true});
        this.fetch(forumId, this.generationByForum.get(forumId) ?? 0, cursor, (s, page) => {
            // Keyset pagination never duplicates, but a concurrent reload can land first -
            // de-duping by id keeps a raced append from doubling a row.
            const seen = new Set(s.posts.map(p => p.id));
            return {...s, posts: [...s.posts, ...page.filter(p => !seen.has(p.id))], loadingMore: false};
        });
    }

    // ── Filters. Changing any of these invalidates the cursor, so every setter
    // routes through a reload rather than mutating and hoping. ────────────────
    toggleTagFilter(forumId: string, tagId: string): void {
        const ids = this.stateFor(forumId).selectedTagIds;
        this.patch(forumId, {selectedTagIds: ids.includes(tagId) ? ids.filter(id => id !== tagId) : [...ids, tagId]});
        this.reload(forumId);
    }

    clearTagFilter(forumId: string): void {
        if (this.stateFor(forumId).selectedTagIds.length === 0) return;
        this.patch(forumId, {selectedTagIds: []});
        this.reload(forumId);
    }

    toggleArchived(forumId: string): void {
        this.patch(forumId, {showArchived: !this.stateFor(forumId).showArchived});
        this.reload(forumId);
    }

    /**
     * Filters belong to the forum you were looking at, not the one you just opened -
     * carrying them across would silently hide posts in the new forum. No fetch: the
     * caller pairs this with the reload that opening a forum does anyway.
     */
    resetFilters(forumId: string): void {
        this.patch(forumId, {selectedTagIds: [], showArchived: false});
    }

    // ── Post edits ───────────────────────────────────────────────────────────
    /** Optimistic local edit; every caller pairs it with a revert on failure. */
    patchPost(forumId: string, postId: string, patch: Partial<ForumPost>): void {
        this.updateLoaded(forumId, s => ({...s, posts: s.posts.map(p => p.id === postId ? {...p, ...patch} : p)}));
    }

    revertPost(forumId: string, original: ForumPost): void {
        this.updateLoaded(forumId, s => ({...s, posts: s.posts.map(p => p.id === original.id ? original : p)}));
    }

    /**
     * Archived posts leave the default list entirely; keeping the card around greyed-out
     * would misrepresent what the filter now matches.
     */
    removePost(forumId: string, postId: string): void {
        this.updateLoaded(forumId, s => ({...s, posts: s.posts.filter(p => p.id !== postId)}));
    }

    // ── Internals ────────────────────────────────────────────────────────────
    private fetch(
        forumId: string,
        generation: number,
        cursor: string | undefined,
        apply: (state: ForumPostListState, posts: ForumPost[]) => ForumPostListState,
    ): void {
        const tagIds = this.stateFor(forumId).selectedTagIds;

        this.forumService.getPosts(forumId, {
            tagIds: tagIds.length ? tagIds : undefined,
            // Multi-select reads as "narrow this down", which is `all`; with one tag the
            // two modes are equivalent, so this is safe to send unconditionally.
            match: tagIds.length > 1 ? 'all' : undefined,
            sort: this.forumState.sortFor(forumId) === ForumSortOrder.CreationDate ? 'created' : 'activity',
            archived: this.stateFor(forumId).showArchived ? 'all' : 'false',
            limit: PAGE_SIZE,
            cursor,
        }).subscribe({
            next: page => {
                // A response for a list the user has already reloaded past must not
                // overwrite the one they're now looking at.
                if ((this.generationByForum.get(forumId) ?? 0) !== generation) return;
                this.updateLoaded(forumId, s => apply({...s, nextCursor: page.nextCursor}, page.posts ?? []));
            },
            error: err => {
                this.patch(forumId, {loading: false, loadingMore: false});
                this.toastService.httpError(this.translate.instant('FORUM.LOAD_ERROR'), err);
            },
        });
    }

    /** Creates the forum's entry if it has none - for the paths that mean "this forum is open". */
    private patch(forumId: string, patch: Partial<ForumPostListState>): void {
        this.stateByForum.update(m => ({...m, [forumId]: {...(m[forumId] ?? EMPTY_STATE), ...patch}}));
    }

    /**
     * Applies only to a forum that already has an entry, mirroring ForumStateService: an
     * event for a forum nobody has opened is dropped rather than conjuring a partial list
     * that stateFor() would then present as if it had been fetched.
     */
    private updateLoaded(forumId: string, fn: (state: ForumPostListState) => ForumPostListState): void {
        this.stateByForum.update(m => {
            if (!m[forumId]) return m;
            return {...m, [forumId]: fn(m[forumId])};
        });
    }

    /**
     * ThreadUpdated carries the full current state of the flags it sends, so each present
     * field replaces rather than merges. An update for a post not on screen is ignored -
     * it'll arrive correct on the next fetch.
     */
    private applyThreadUpdate(
        forumId: string,
        postId: string,
        e: {name?: string; tagIds?: string[]; isPinned?: boolean; isLocked?: boolean; isArchived?: boolean},
    ): void {
        const patch: Partial<ForumPost> = {};
        if (e.name !== undefined) patch.name = e.name;
        if (e.tagIds !== undefined) patch.tagIds = e.tagIds;
        if (e.isPinned !== undefined) patch.isPinned = e.isPinned;
        if (e.isLocked !== undefined) patch.isLocked = e.isLocked;
        if (e.isArchived !== undefined) patch.isArchived = e.isArchived;

        this.updateLoaded(forumId, s => {
            if (!s.posts.some(p => p.id === postId)) return s;
            const next = s.posts.map(p => p.id === postId ? {...p, ...patch} : p);
            return {...s, posts: e.isArchived && !s.showArchived ? next.filter(p => p.id !== postId) : next};
        });
    }
}
