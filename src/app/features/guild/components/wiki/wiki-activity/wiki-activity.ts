import {WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';

/**
 * The wiki's activity feed, derived entirely from the page summaries the wiki listing already
 * returns.
 *
 * There is no activity endpoint and this does not need one: every summary carries `createdAt` /
 * `authorId` and `updatedAt` / `lastEditorId`, which is exactly two events per page. Anything
 * richer - per-revision history for every page - would be one request per page, for a panel that
 * shows twenty rows.
 */

export type WikiActivityKind = 'created' | 'edited';

export interface WikiActivityEntry {
    /**
     * Stable for a given page and kind, so the feed re-rendering after a wiki reload reuses rows
     * instead of tearing them down and losing their avatars mid-fetch.
     */
    id: string;
    kind: WikiActivityKind;
    page: WikiPageSummaryDto;
    /** Absent when the summary names nobody; the row then shows a face with no name, not an id. */
    actorId?: string;
    /** Epoch ms, so sorting never re-parses. */
    at: number;
    /**
     * The same instant as a `Date`, built once here rather than in the template. `relativeTime` is
     * a pure pipe, and a `Date` constructed during change detection is a new identity every cycle,
     * which would make it recompute on every tick of every unrelated signal.
     */
    date: Date;
}

/**
 * How far `updatedAt` has to be past `createdAt` before a page counts as edited.
 *
 * A freshly created page has the two stamps within milliseconds of each other, and reporting that
 * as both "created Rules" and "edited Rules" makes every new page occupy two rows saying the same
 * thing. A minute is far longer than the write takes and far shorter than a real follow-up edit.
 */
const EDIT_EPSILON_MS = 60_000;

export const WIKI_ACTIVITY_DEFAULT_LIMIT = 24;

export function buildWikiActivity(
    pages: readonly WikiPageSummaryDto[],
    limit: number = WIKI_ACTIVITY_DEFAULT_LIMIT,
): WikiActivityEntry[] {
    const entries: WikiActivityEntry[] = [];

    for (const page of pages) {
        const created = toEpoch(page.createdAt);
        const updated = toEpoch(page.updatedAt);

        if (created !== null) {
            entries.push({
                id: `created:${page.id}`,
                kind: 'created',
                page,
                actorId: page.authorId || undefined,
                at: created,
                date: new Date(created),
            });
        }

        if (updated !== null && (created === null || updated - created > EDIT_EPSILON_MS)) {
            entries.push({
                id: `edited:${page.id}`,
                kind: 'edited',
                page,
                // Falls back to the author: an edit with no recorded editor is still somebody's,
                // and the page's author is the only name we have for it.
                actorId: page.lastEditorId || page.authorId || undefined,
                at: updated,
                date: new Date(updated),
            });
        }
    }

    // Ties broken by title so the order is stable rather than dependent on page order, which the
    // listing does not promise.
    entries.sort((a, b) => b.at - a.at || a.page.title.localeCompare(b.page.title));
    return limit > 0 ? entries.slice(0, limit) : entries;
}

/** Distinct people who have written or touched anything here. */
export function countContributors(pages: readonly WikiPageSummaryDto[]): number {
    const ids = new Set<string>();
    for (const page of pages) {
        if (page.authorId) ids.add(page.authorId);
        if (page.lastEditorId) ids.add(page.lastEditorId);
    }
    return ids.size;
}

/** Dates arrive as `Date` per the DTO but as ISO strings over the wire. Both have to work. */
function toEpoch(value: Date | string | null | undefined): number | null {
    if (!value) return null;
    const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isNaN(ms) ? null : ms;
}
