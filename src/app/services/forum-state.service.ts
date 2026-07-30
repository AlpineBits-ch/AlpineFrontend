import {inject, Injectable, signal} from '@angular/core';
import {ForumConfig, ForumLayout, ForumSortOrder, ForumTag} from '../dtos/response/forum.dto';
import {ForumService} from './forum.service';
import {GuildWebsocketService} from './guild-websocket.service';

/**
 * Per-forum tag list and config, shared by the forum view and the moderator tag
 * editor so a change made in settings shows up in the post list without a refetch.
 *
 * Tags and config are small, near-static and read on every render of a forum, so
 * they're cached for the session and kept fresh by the realtime events rather than
 * re-fetched. Posts are deliberately *not* cached here - they're paginated, filtered
 * and volatile, so the forum view owns that list.
 */
@Injectable({providedIn: 'root'})
export class ForumStateService {
    private readonly tagsByForum = signal<Record<string, ForumTag[]>>({});
    private readonly configByForum = signal<Record<string, ForumConfig>>({});
    /** Local, per-user view preference; seeded from the forum's defaults on first read. */
    private readonly layoutByForum = signal<Record<string, ForumLayout>>({});
    private readonly sortByForum = signal<Record<string, ForumSortOrder>>({});

    private readonly requested = new Set<string>();

    private forumService = inject(ForumService);
    private ws = inject(GuildWebsocketService);

    constructor() {
        this.ws.forumTagCreatedObservable.subscribe(e =>
            this.replaceTags(e.channelId, list => this.sorted([...list.filter(t => t.id !== e.tag.id), e.tag])));

        this.ws.forumTagUpdatedObservable.subscribe(e =>
            this.replaceTags(e.channelId, list => this.sorted(list.map(t => t.id === e.tag.id ? e.tag : t))));

        this.ws.forumTagDeletedObservable.subscribe(e =>
            this.replaceTags(e.channelId, list => list.filter(t => t.id !== e.tagId)));

        // The event carries the full ordered list, so positions are re-derived from
        // the array index rather than trusting whatever each cached tag last held.
        this.ws.forumTagsReorderedObservable.subscribe(e =>
            this.replaceTags(e.channelId, list => e.tagIds
                .map((id, position) => {
                    const tag = list.find(t => t.id === id);
                    return tag ? {...tag, position} : null;
                })
                .filter((t): t is ForumTag => t !== null)));

        this.ws.forumConfigUpdatedObservable.subscribe(e =>
            this.configByForum.update(m => ({...m, [e.channelId]: e.config})));
    }

    tagsFor(forumId: string): ForumTag[] {
        return this.tagsByForum()[forumId] ?? [];
    }

    tagFor(forumId: string, tagId: string): ForumTag | undefined {
        return this.tagsFor(forumId).find(t => t.id === tagId);
    }

    configFor(forumId: string): ForumConfig | undefined {
        return this.configByForum()[forumId];
    }

    layoutFor(forumId: string): ForumLayout {
        return this.layoutByForum()[forumId] ?? this.configFor(forumId)?.defaultLayout ?? ForumLayout.List;
    }

    sortFor(forumId: string): ForumSortOrder {
        return this.sortByForum()[forumId] ?? this.configFor(forumId)?.defaultSortOrder ?? ForumSortOrder.LatestActivity;
    }

    setLayout(forumId: string, layout: ForumLayout): void {
        this.layoutByForum.update(m => ({...m, [forumId]: layout}));
    }

    setSort(forumId: string, sort: ForumSortOrder): void {
        this.sortByForum.update(m => ({...m, [forumId]: sort}));
    }

    /** Idempotent per forum for the session; call it freely on every forum open. */
    loadFor(forumId: string): void {
        if (this.requested.has(forumId)) return;
        this.requested.add(forumId);
        this.refresh(forumId);
    }

    /** Forces a re-read - used after the moderator editor writes. */
    refresh(forumId: string): void {
        this.forumService.getTags(forumId).subscribe({
            next: tags => this.tagsByForum.update(m => ({...m, [forumId]: this.sorted(tags)})),
            // A missing tag list must not break the post list: an empty filter bar is a
            // degraded but working forum, whereas failing loudly here would block reading.
            error: () => this.tagsByForum.update(m => ({...m, [forumId]: m[forumId] ?? []})),
        });

        this.forumService.getConfig(forumId).subscribe({
            next: config => this.configByForum.update(m => ({...m, [forumId]: config})),
            error: () => undefined,
        });
    }

    /** Applied locally after a write so the UI doesn't wait for the echo event. */
    putTags(forumId: string, tags: ForumTag[]): void {
        this.tagsByForum.update(m => ({...m, [forumId]: this.sorted(tags)}));
    }

    putConfig(forumId: string, config: ForumConfig): void {
        this.configByForum.update(m => ({...m, [forumId]: config}));
    }

    private replaceTags(forumId: string, fn: (list: ForumTag[]) => ForumTag[]): void {
        this.tagsByForum.update(m => {
            // Ignore events for forums nobody has opened - loadFor will fetch the
            // authoritative list when they do, and inventing a partial one here would
            // make tagsFor() look complete when it isn't.
            if (!m[forumId]) return m;
            return {...m, [forumId]: fn(m[forumId])};
        });
    }

    /** Server order: position ascending, ties broken by name. */
    private sorted(tags: ForumTag[]): ForumTag[] {
        return [...tags].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    }
}
