import {effect, inject, Injectable, signal, untracked} from '@angular/core';
import {NavigationService} from '../features/main-page/navigation.service';
import {forumParentOf} from '../features/guild/components/channel/channel-utils';

const STORAGE_KEY = 'alpine.forum.visitedPosts';

/**
 * How many visited posts a single forum keeps. Small on purpose: these rows exist to get
 * you back to what you were just reading, not to be a history. Unread and mentioned posts
 * are shown regardless and are not counted against this - see selectNestedPosts.
 */
export const VISITED_POSTS_PER_FORUM = 5;

/** forumId -> post ids, most recently visited first. */
type VisitedMap = Record<string, string[]>;

/**
 * Remembers which forum posts the user has opened, so the sidebar can keep showing them
 * beneath their forum after they have been read.
 *
 * Recording happens here rather than at the call sites that open a post, because there are
 * four of them - the full-width post list, the narrow pane, a sidebar row, and nav restored
 * from localStorage on reload - and a missed one would silently drop posts from the sidebar.
 * Watching the main view catches all four, including the restore, which no click handler
 * ever runs for.
 */
@Injectable({providedIn: 'root'})
export class ForumVisitedPostsService {
    private navService = inject(NavigationService);

    private readonly visited = signal<VisitedMap>(load());

    constructor() {
        effect(() => {
            const view = this.navService.mainView();
            const ws = this.navService.workspace();
            if (view.type !== 'channel' || ws.type !== 'server') return;

            const forum = forumParentOf(view.channel, ws.guild.channels);
            if (!forum) return;

            untracked(() => this.record(forum.id, view.channel.id));
        });
    }

    /** Most recently visited first. Empty for a forum whose posts have never been opened. */
    postsFor(forumId: string): readonly string[] {
        return this.visited()[forumId] ?? [];
    }

    /**
     * Moves a post to the front, evicting the oldest past the cap. Re-visiting the post
     * already at the front is a no-op down to object identity, so the effect that calls
     * this on every main-view change doesn't churn the signal on unrelated navigation.
     */
    private record(forumId: string, postId: string): void {
        const current = this.visited()[forumId] ?? [];
        if (current[0] === postId) return;

        const next = [postId, ...current.filter(id => id !== postId)].slice(0, VISITED_POSTS_PER_FORUM);
        this.visited.update(map => {
            const updated = {...map, [forumId]: next};
            save(updated);
            return updated;
        });
    }
}

/**
 * A malformed or foreign value reads as "nothing visited yet" rather than throwing -
 * losing these rows is a cosmetic regression, but throwing here would take the sidebar
 * down with it. Entries are shape-checked individually so one bad forum can't discard
 * the rest.
 */
function load(): VisitedMap {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

        const out: VisitedMap = {};
        for (const [forumId, ids] of Object.entries(parsed as Record<string, unknown>)) {
            if (!Array.isArray(ids)) continue;
            const clean = ids.filter((id): id is string => typeof id === 'string');
            if (clean.length) out[forumId] = clean.slice(0, VISITED_POSTS_PER_FORUM);
        }
        return out;
    } catch {
        return {};
    }
}

/** A full storage quota must not break navigation, which is all this is decorating. */
function save(map: VisitedMap): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
    } catch {
        // ignored
    }
}
