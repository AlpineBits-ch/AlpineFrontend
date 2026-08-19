import {effect, inject, Injectable, signal, untracked} from '@angular/core';
import {NavigationService} from '../features/main-page/navigation.service';
import {forumParentOf} from '../features/guild/components/channel/channel-utils';

const STORAGE_KEY = 'alpine.forum.visitedPosts';

/**
 * How many visited threads a single parent keeps. Small on purpose: these rows exist to get
 * you back to what you were just reading, not to be a history. Unread and mentioned threads
 * are shown regardless and are not counted against this - see selectNestedThreads.
 */
export const VISITED_THREADS_PER_PARENT = 5;

/** parentId -> thread ids, most recently visited first. */
type VisitedMap = Record<string, string[]>;

/**
 * Remembers which threads the user has opened, so the sidebar can keep showing them beneath
 * their parent after they have been read. Forum posts and text-channel threads both land here.
 *
 * A forum post is recorded by watching the main view, because there are four ways to open one -
 * the full-width post list, the narrow pane, a sidebar row, and nav restored from localStorage on
 * reload - and a missed one would silently drop posts from the sidebar. A text-channel thread opens
 * in a side panel and never changes the main view, so NavigationService.openThread calls record.
 */
@Injectable({providedIn: 'root'})
export class VisitedThreadsService {
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

    /** Most recently visited first. Empty for a parent whose threads have never been opened. */
    threadsFor(parentId: string): readonly string[] {
        return this.visited()[parentId] ?? [];
    }

    /**
     * Moves a thread to the front, evicting the oldest past the cap. Re-visiting the thread
     * already at the front is a no-op down to object identity, so the effect that calls
     * this on every main-view change doesn't churn the signal on unrelated navigation.
     */
    record(parentId: string, threadId: string): void {
        const current = this.visited()[parentId] ?? [];
        if (current[0] === threadId) return;

        const next = [threadId, ...current.filter(id => id !== threadId)].slice(
            0,
            VISITED_THREADS_PER_PARENT,
        );
        this.visited.update(map => {
            const updated = {...map, [parentId]: next};
            save(updated);
            return updated;
        });
    }
}

/**
 * A malformed or foreign value reads as "nothing visited yet" rather than throwing -
 * losing these rows is a cosmetic regression, but throwing here would take the sidebar
 * down with it. Entries are shape-checked individually so one bad parent can't discard
 * the rest.
 */
function load(): VisitedMap {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

        const out: VisitedMap = {};
        for (const [parentId, ids] of Object.entries(parsed as Record<string, unknown>)) {
            if (!Array.isArray(ids)) continue;
            const clean = ids.filter((id): id is string => typeof id === 'string');
            if (clean.length) out[parentId] = clean.slice(0, VISITED_THREADS_PER_PARENT);
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
