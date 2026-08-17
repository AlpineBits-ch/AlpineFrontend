/**
 * Search ranking.
 *
 * Two tiers, because `getWiki` returns summaries without content: titles and tags are always
 * available and score highest, while content is present only for pages the content cache has
 * fetched. Scores are fixed bands rather than a tuned relevance function - the point is that a
 * title beats a tag beats a body mention, predictably.
 */

export interface SearchCandidate {
    id: string;
    title: string;
    tags: readonly string[];
    content?: string;
    /** Only read by the filters; ranking never looks at either. */
    categoryId?: string;
    authorId?: string;
}

/** Narrowing applied before ranking. An unset field means "no constraint", never "must be empty". */
export interface SearchFilters {
    tag?: string;
    categoryId?: string;
    authorId?: string;
}

export type MatchField = 'title' | 'tag' | 'content';

export interface SearchHit {
    id: string;
    score: number;
    matchedIn: MatchField;
    /** Context around a content match; null when the match was in the title or a tag. */
    snippet: string | null;
}

const SCORE_TITLE_EXACT = 1000;
const SCORE_TITLE_PREFIX = 800;
const SCORE_TITLE_WORD_PREFIX = 600;
const SCORE_TITLE_SUBSTRING = 400;
const SCORE_TAG_EXACT = 350;
const SCORE_TAG_PREFIX = 300;
const SCORE_TITLE_SUBSEQUENCE = 200;
const SCORE_CONTENT = 100;

const SNIPPET_RADIUS = 40;

/** True when every character of `query` appears in `text` in order, not necessarily adjacent. */
function isSubsequence(text: string, query: string): boolean {
    if (query.length === 0) return true;
    let index = 0;
    for (const char of text) {
        if (char === query[index]) index++;
        if (index === query.length) return true;
    }
    return false;
}

function snippetAround(content: string, at: number, queryLength: number): string {
    const start = Math.max(0, at - SNIPPET_RADIUS);
    const end = Math.min(content.length, at + queryLength + SNIPPET_RADIUS);
    return `${start > 0 ? '…' : ''}${content.slice(start, end).trim()}${end < content.length ? '…' : ''}`;
}

function scoreOne(candidate: SearchCandidate, query: string): SearchHit | null {
    const title = candidate.title.toLowerCase();

    if (title === query) return {id: candidate.id, score: SCORE_TITLE_EXACT, matchedIn: 'title', snippet: null};
    if (title.startsWith(query)) return {id: candidate.id, score: SCORE_TITLE_PREFIX, matchedIn: 'title', snippet: null};
    if (title.split(/\s+/).some(word => word.startsWith(query))) {
        return {id: candidate.id, score: SCORE_TITLE_WORD_PREFIX, matchedIn: 'title', snippet: null};
    }
    if (title.includes(query)) return {id: candidate.id, score: SCORE_TITLE_SUBSTRING, matchedIn: 'title', snippet: null};

    for (const tag of candidate.tags) {
        const lower = tag.toLowerCase();
        if (lower === query) return {id: candidate.id, score: SCORE_TAG_EXACT, matchedIn: 'tag', snippet: null};
        if (lower.startsWith(query)) return {id: candidate.id, score: SCORE_TAG_PREFIX, matchedIn: 'tag', snippet: null};
    }

    if (isSubsequence(title, query)) {
        return {id: candidate.id, score: SCORE_TITLE_SUBSEQUENCE, matchedIn: 'title', snippet: null};
    }

    if (candidate.content) {
        const at = candidate.content.toLowerCase().indexOf(query);
        if (at !== -1) {
            return {
                id: candidate.id,
                score: SCORE_CONTENT,
                matchedIn: 'content',
                snippet: snippetAround(candidate.content, at, query.length),
            };
        }
    }

    return null;
}

export function hasActiveFilters(filters: SearchFilters): boolean {
    return !!(filters.tag || filters.categoryId || filters.authorId);
}

export function matchesFilters(candidate: SearchCandidate, filters: SearchFilters): boolean {
    if (filters.tag && !candidate.tags.some(t => t.toLowerCase() === filters.tag!.toLowerCase())) return false;
    if (filters.categoryId && candidate.categoryId !== filters.categoryId) return false;
    return !(filters.authorId && candidate.authorId !== filters.authorId);
}

export function searchWiki(
    candidates: readonly SearchCandidate[],
    query: string,
    limit = 25,
    filters: SearchFilters = {},
): SearchHit[] {
    const normalised = query.trim().toLowerCase();
    const filtered = hasActiveFilters(filters)
        ? candidates.filter(c => matchesFilters(c, filters))
        : candidates;

    // A filter with no query is a browse, not a dead end: "everything tagged deploy" is a
    // question worth answering, and answering it with nothing would look broken.
    if (!normalised) {
        if (!hasActiveFilters(filters)) return [];
        return [...filtered]
            .sort((a, b) => a.title.localeCompare(b.title))
            .slice(0, limit)
            .map(c => ({id: c.id, score: 0, matchedIn: 'title' as const, snippet: null}));
    }

    const titleById = new Map(filtered.map(c => [c.id, c.title]));

    return filtered
        .map(candidate => scoreOne(candidate, normalised))
        .filter((hit): hit is SearchHit => hit !== null)
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            // Deterministic tie-break, so identical queries never reorder between renders.
            const titleA = titleById.get(a.id) ?? '';
            const titleB = titleById.get(b.id) ?? '';
            if (titleA.length !== titleB.length) return titleA.length - titleB.length;
            return titleA.localeCompare(titleB);
        })
        .slice(0, limit);
}

export interface PathPage {
    id: string;
    title: string;
    parentPageId?: string;
    categoryId?: string;
}

export interface PathCategory {
    id: string;
    name: string;
    parentCategoryId?: string;
}

/**
 * Where a page sits, outermost first: `['Guides', 'Deploying', 'Rollback']`.
 *
 * Two pages called "Overview" are indistinguishable in a result list, which is exactly the case
 * search has to get right. Both walks are cycle-guarded because the data allows a page to be its
 * own ancestor - `buildPageTree` in the nav already defends against the same shape.
 */
export function wikiPagePath(
    pageId: string,
    pages: readonly PathPage[],
    categories: readonly PathCategory[],
): string[] {
    const pageById = new Map(pages.map(p => [p.id, p]));
    const page = pageById.get(pageId);
    if (!page) return [];

    const ancestors: string[] = [];
    const seen = new Set<string>([page.id]);
    let currentId = page.parentPageId;
    while (currentId && !seen.has(currentId)) {
        seen.add(currentId);
        const parent = pageById.get(currentId);
        if (!parent) break;
        ancestors.unshift(parent.title);
        currentId = parent.parentPageId;
    }

    const categoryById = new Map(categories.map(c => [c.id, c]));
    const categoryTrail: string[] = [];
    const seenCategories = new Set<string>();
    let categoryId = page.categoryId;
    while (categoryId && !seenCategories.has(categoryId)) {
        seenCategories.add(categoryId);
        const category = categoryById.get(categoryId);
        if (!category) break;
        categoryTrail.unshift(category.name);
        categoryId = category.parentCategoryId;
    }

    return [...categoryTrail, ...ancestors, page.title];
}
