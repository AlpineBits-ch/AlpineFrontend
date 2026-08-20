import {computed, inject, Injectable, signal} from '@angular/core';

import {RoleplayApi} from './roleplay-api.service';
import {SceneListItemDto} from '../dtos/response/scene.dto';
import {SceneListParams, SceneSort, UNFILED} from '../dtos/request/scene.dto';

/** What the archive is currently asking for. Every field is part of the cache key. */
export interface ArchiveFilter {
    guildId: string;
    /** A folder id, `UNFILED`, or null for every shelf. */
    folderId: string | null;
    tagIds: string[];
    q: string;
    /** Defaults to `ended` when a caller does not choose. */
    sort?: SceneSort;
}

const PAGE_SIZE = 50;
const DEFAULT_SORT: SceneSort = 'ended';

export function archiveKey(filter: ArchiveFilter): string {
    return [
        filter.guildId,
        filter.folderId ?? '*',
        filter.sort ?? DEFAULT_SORT,
        [...filter.tagIds].sort().join('+'),
        filter.q,
    ].join('|');
}

/**
 * The archive's own query. Separate from SceneService on purpose: that one holds a guild's live
 * board, and paging a two-year archive through it would churn the rows the board is drawing.
 */
@Injectable({providedIn: 'root'})
export class SceneArchiveService {
    private readonly api = inject(RoleplayApi);

    private readonly pages = signal<Record<string, SceneListItemDto[]>>({});
    private readonly loadingKeys = signal<Record<string, boolean>>({});
    private readonly exhausted = signal<Record<string, boolean>>({});
    private readonly failed = signal<Record<string, boolean>>({});
    private readonly truncatedKeys = signal<Record<string, boolean>>({});

    private readonly filter = signal<ArchiveFilter | null>(null);

    readonly current = this.filter.asReadonly();

    readonly scenes = computed(() => {
        const filter = this.filter();
        return filter ? (this.pages()[archiveKey(filter)] ?? []) : [];
    });

    readonly loading = computed(() => {
        const filter = this.filter();
        return !!filter && !!this.loadingKeys()[archiveKey(filter)];
    });

    readonly hasMore = computed(() => {
        const filter = this.filter();
        if (!filter) return false;
        const key = archiveKey(filter);
        return !!this.pages()[key] && !this.exhausted()[key];
    });

    /** True when more scenes matched this filter than the route will ever return. */
    readonly truncated = computed(() => {
        const filter = this.filter();
        return !!filter && !!this.truncatedKeys()[archiveKey(filter)];
    });

    readonly errored = computed(() => {
        const filter = this.filter();
        return !!filter && !!this.failed()[archiveKey(filter)];
    });

    /** True before the first page of this filter has ever landed. */
    readonly unread = computed(() => {
        const filter = this.filter();
        return !filter || !this.pages()[archiveKey(filter)];
    });

    /** Points the archive at a filter, reading its first page unless it is already held. */
    apply(filter: ArchiveFilter): void {
        this.filter.set(filter);
        const key = archiveKey(filter);
        if (this.pages()[key] || this.loadingKeys()[key]) return;
        this.read(filter, 0);
    }

    refresh(): void {
        const filter = this.filter();
        if (!filter) return;
        this.pages.update(map => {
            const next = {...map};
            delete next[archiveKey(filter)];
            return next;
        });
        this.read(filter, 0);
    }

    more(): void {
        const filter = this.filter();
        if (!filter || this.loading() || !this.hasMore()) return;
        this.read(filter, this.scenes().length);
    }

    /** Applies a local change to a row wherever it is cached, so filing does not need a refetch. */
    patch(channelId: string, patch: Partial<SceneListItemDto>): void {
        this.pages.update(map => {
            const next: Record<string, SceneListItemDto[]> = {};
            for (const [key, rows] of Object.entries(map)) {
                next[key] = rows.map(row => (row.channelId === channelId ? {...row, ...patch} : row));
            }
            return next;
        });
    }

    /** Drops a row from every cached page, for when it no longer matches the filter it was read under. */
    drop(channelId: string): void {
        this.pages.update(map => {
            const next: Record<string, SceneListItemDto[]> = {};
            for (const [key, rows] of Object.entries(map)) {
                next[key] = rows.filter(row => row.channelId !== channelId);
            }
            return next;
        });
    }

    private read(filter: ArchiveFilter, offset: number): void {
        const key = archiveKey(filter);
        this.loadingKeys.update(map => ({...map, [key]: true}));
        this.failed.update(map => ({...map, [key]: false}));

        this.api.listScenes(filter.guildId, this.params(filter, offset)).subscribe({
            next: page => {
                const rows = page.scenes ?? [];
                this.pages.update(map => ({
                    ...map,
                    [key]: offset === 0 ? rows : [...(map[key] ?? []), ...rows],
                }));
                // A short page is the end. `truncated` answers a different question: whether more
                // matched than the route would return at all.
                this.exhausted.update(map => ({...map, [key]: rows.length < PAGE_SIZE}));
                this.truncatedKeys.update(map => ({...map, [key]: !!page.truncated}));
                this.loadingKeys.update(map => ({...map, [key]: false}));
            },
            error: () => {
                this.loadingKeys.update(map => ({...map, [key]: false}));
                this.failed.update(map => ({...map, [key]: true}));
                // An empty page rather than nothing, so a first-read failure renders as an error
                // state instead of as a permanent skeleton.
                if (offset === 0) this.pages.update(map => ({...map, [key]: map[key] ?? []}));
            },
        });
    }

    private params(filter: ArchiveFilter, offset: number): SceneListParams {
        return {
            includeConcluded: true,
            includeArchived: true,
            archivedOnly: true,
            sort: filter.sort ?? DEFAULT_SORT,
            limit: PAGE_SIZE,
            offset,
            folderId: filter.folderId ?? undefined,
            tagIds: filter.tagIds.length ? filter.tagIds : undefined,
            q: filter.q || undefined,
        };
    }
}

export {UNFILED};
