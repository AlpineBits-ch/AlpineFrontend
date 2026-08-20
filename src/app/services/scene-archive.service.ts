import {computed, inject, Injectable, signal} from '@angular/core';
import {map, Observable, tap} from 'rxjs';

import {RoleplayApi} from './roleplay-api.service';
import {SceneListItemDto} from '../dtos/response/scene.dto';
import {SceneListParams, SceneSort, UNFILED} from '../dtos/request/scene.dto';

/** Which slice of a guild's scenes the archive is showing. */
export type ArchiveStatus = 'all' | 'running' | 'finished';

/** What the archive is currently asking for. Every field is part of the cache key. */
export interface ArchiveFilter {
    guildId: string;
    /** A folder id, `UNFILED`, or null for every shelf. */
    folderId: string | null;
    tagIds: string[];
    q: string;
    /** Defaults to `ended` when a caller does not choose. */
    sort?: SceneSort;
    /** Defaults to `all`: the archive holds running scenes now, not only finished ones. */
    status?: ArchiveStatus;
}

const PAGE_SIZE = 50;
const DEFAULT_SORT: SceneSort = 'ended';
const DEFAULT_STATUS: ArchiveStatus = 'all';
const EMPTY_ROWS: readonly SceneListItemDto[] = [];
const ARCHIVE_STATUSES: readonly ArchiveStatus[] = ['all', 'running', 'finished'];

export function archiveKey(filter: ArchiveFilter): string {
    return [
        filter.guildId,
        filter.folderId ?? '*',
        filter.sort ?? DEFAULT_SORT,
        filter.status ?? DEFAULT_STATUS,
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

    /** The freshest cached copy of a row, wherever it is held. Reads ahead of `patch`, which only
     *  rewrites a row where it already sits, never moves it. */
    cachedRow(channelId: string): SceneListItemDto | undefined {
        for (const rows of Object.values(this.pages())) {
            const row = rows.find(r => r.channelId === channelId);
            if (row) return row;
        }
        return undefined;
    }

    /** Shared by both filing UIs: patches the moved row and invalidates both shelves once `move`
     *  settles. Emits the folder the scene moved out of, so a caller can react to the old shelf too. */
    fileScene(
        guildId: string,
        channelId: string,
        folderId: string | null,
        move: Observable<unknown>,
    ): Observable<string | null> {
        const from = this.cachedRow(channelId)?.folderId ?? null;
        return move.pipe(
            tap(() => {
                this.patch(channelId, {folderId});
                this.invalidateShelves(guildId, from, folderId);
            }),
            map(() => from),
        );
    }

    /** Drops both shelves' cached pages so an open one re-reads. Filing moves a row between keys, and
     *  `patch` only rewrites it in place. */
    invalidateShelves(guildId: string, ...folderIds: (string | null)[]): void {
        const keys = new Set<string>();
        for (const folderId of folderIds) {
            for (const status of ARCHIVE_STATUSES) {
                keys.add(archiveKey(shelfFilter(guildId, folderId, status)));
            }
        }
        this.pages.update(map => {
            const next = {...map};
            for (const key of keys) delete next[key];
            return next;
        });
        this.exhausted.update(map => {
            const next = {...map};
            for (const key of keys) delete next[key];
            return next;
        });

        // A shelf key is the selection's own key whenever nothing is filtered, so clearing it takes
        // the rows out from under the list on screen and no input changes to make `apply` re-read.
        const current = this.filter();
        if (current && keys.has(archiveKey(current))) this.read(current, 0);
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

    /** Reads a shelf's scenes into the cache without moving the selection. */
    peek(guildId: string, folderId: string | null, status: ArchiveStatus = DEFAULT_STATUS): void {
        const filter = shelfFilter(guildId, folderId, status);
        const key = archiveKey(filter);
        if (this.pages()[key] || this.loadingKeys()[key]) return;
        this.read(filter, 0);
    }

    peeked(
        guildId: string,
        folderId: string | null,
        status: ArchiveStatus = DEFAULT_STATUS,
    ): readonly SceneListItemDto[] {
        return this.pages()[archiveKey(shelfFilter(guildId, folderId, status))] ?? EMPTY_ROWS;
    }

    peekLoading(guildId: string, folderId: string | null, status: ArchiveStatus = DEFAULT_STATUS): boolean {
        return !!this.loadingKeys()[archiveKey(shelfFilter(guildId, folderId, status))];
    }

    /** False while more of this shelf is still unread, so its count is a floor rather than a total. */
    peekExhausted(guildId: string, folderId: string | null, status: ArchiveStatus = DEFAULT_STATUS): boolean {
        return !!this.exhausted()[archiveKey(shelfFilter(guildId, folderId, status))];
    }

    private params(filter: ArchiveFilter, offset: number): SceneListParams {
        return {
            ...statusFlags(filter.status ?? DEFAULT_STATUS),
            sort: filter.sort ?? DEFAULT_SORT,
            limit: PAGE_SIZE,
            offset,
            folderId: filter.folderId ?? undefined,
            tagIds: filter.tagIds.length ? filter.tagIds : undefined,
            q: filter.q || undefined,
        };
    }
}

/** `running` sends no flags at all: the live board is what the route returns by default. */
function statusFlags(status: ArchiveStatus): Partial<SceneListParams> {
    if (status === 'running') return {};
    const both = {includeConcluded: true, includeArchived: true};
    return status === 'finished' ? {...both, archivedOnly: true} : both;
}

/** No tags and no query, so a shelf and the same shelf selected unfiltered are one cache entry. */
function shelfFilter(guildId: string, folderId: string | null, status: ArchiveStatus): ArchiveFilter {
    return {guildId, folderId, tagIds: [], q: '', sort: DEFAULT_SORT, status};
}

export {UNFILED};
