import {WikiCategoryDto, WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';
import {wikiPagePath} from '../wiki-search';

/**
 * The nav as one flat list. Everything the template draws is a row here, in the order it appears,
 * so the tree costs one pass over the pages instead of a rebuild per category per change detection.
 */

/** Also the cap on stored recents, so nothing is remembered that can never be shown. */
export const SHORTCUT_LIMIT = 6;

export type ShortcutReason = 'favourite' | 'pinned' | 'recent';

export type NavRowKind = 'shortcut' | 'divider' | 'header' | 'category' | 'page' | 'empty';

export interface NavRow {
    readonly kind: NavRowKind;
    /** Unique across the whole list; ids alone are not, a page can be a shortcut and a tree row. */
    readonly key: string;
    readonly id: string;
    /** Nesting under its own parent chain: a category's depth among categories, a page's among pages. */
    readonly depth: number;
    /** Absolute indentation level, and `aria-level` minus one. */
    readonly level: number;
    readonly title: string;
    /** Translation key, for the rows whose text is not user content. */
    readonly labelKey: string;
    readonly icon: string;
    readonly tooltip: string;
    readonly focusable: boolean;
    readonly draggable: boolean;
    readonly expandable: boolean;
    readonly collapsed: boolean;
    readonly favourite: boolean;
    readonly pinned: boolean;
    readonly shortcutOf?: ShortcutReason;
    readonly page?: WikiPageSummaryDto;
    readonly category?: WikiCategoryDto;
}

export interface NavRowInput {
    /** Already narrowed by the filter. */
    readonly categories: readonly WikiCategoryDto[];
    readonly pages: readonly WikiPageSummaryDto[];
    /** Unnarrowed: an ancestor the filter hid is still part of where a page lives. */
    readonly allPages: readonly WikiPageSummaryDto[];
    readonly allCategories: readonly WikiCategoryDto[];
    readonly collapsedIds: ReadonlySet<string>;
    readonly favourites: readonly string[];
    readonly recents: readonly string[];
    readonly canDrag: boolean;
}

const CATEGORY_ICON = 'pi-folder';
const PAGE_ICON = 'pi-file';
const CHILD_PAGE_ICON = 'pi-file-minus';
const SHORTCUT_ICONS: Record<ShortcutReason, string> = {
    favourite: 'pi-star-fill',
    pinned: 'pi-bookmark-fill',
    recent: 'pi-clock',
};

function byCategory(a: WikiCategoryDto, b: WikiCategoryDto): number {
    if (a.position !== b.position) return a.position - b.position;
    const name = a.name.localeCompare(b.name);
    return name !== 0 ? name : a.id.localeCompare(b.id);
}

function byPage(a: WikiPageSummaryDto, b: WikiPageSummaryDto): number {
    const title = a.title.localeCompare(b.title);
    return title !== 0 ? title : a.id.localeCompare(b.id);
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
    const bucket = map.get(key);
    if (bucket) bucket.push(value);
    else map.set(key, [value]);
}

/** Ancestor categories of a page, outermost first. Ids, which is what un-collapsing needs; `wikiPagePath` answers the same question in titles. */
export function ancestorCategoryIds(
    pageId: string,
    pages: readonly WikiPageSummaryDto[],
    categories: readonly WikiCategoryDto[],
): string[] {
    const page = pages.find(p => p.id === pageId);
    if (!page?.categoryId) return [];
    const byId = new Map(categories.map(c => [c.id, c]));
    const trail: string[] = [];
    const seen = new Set<string>();
    let current: string | undefined = page.categoryId;
    while (current && !seen.has(current)) {
        seen.add(current);
        const category = byId.get(current);
        if (!category) break;
        trail.unshift(category.id);
        current = category.parentCategoryId;
    }
    return trail;
}

/** At most {@link SHORTCUT_LIMIT} pages, each named once, favourite before pinned before recent. */
export function buildShortcuts(
    pages: readonly WikiPageSummaryDto[],
    favourites: readonly string[],
    recents: readonly string[],
    limit = SHORTCUT_LIMIT,
): {page: WikiPageSummaryDto; reason: ShortcutReason}[] {
    const byId = new Map(pages.map(p => [p.id, p]));
    const taken = new Set<string>();
    const out: {page: WikiPageSummaryDto; reason: ShortcutReason}[] = [];

    const add = (page: WikiPageSummaryDto | undefined, reason: ShortcutReason) => {
        if (!page || taken.has(page.id) || out.length >= limit) return;
        taken.add(page.id);
        out.push({page, reason});
    };

    for (const id of favourites) add(byId.get(id), 'favourite');
    for (const page of pages.filter(p => p.isPinned).sort(byPage)) add(page, 'pinned');
    for (const id of recents) add(byId.get(id), 'recent');
    return out;
}

export function buildNavRows(input: NavRowInput): NavRow[] {
    const visiblePages = input.pages;
    const visibleCategories = input.categories;

    const favourites = new Set(input.favourites);
    const rows: NavRow[] = [];

    const shortcuts = buildShortcuts(visiblePages, input.favourites, input.recents);
    for (const {page, reason} of shortcuts) {
        rows.push(
            pageRow(page, {
                kind: 'shortcut',
                key: `s:${page.id}`,
                depth: 0,
                level: 0,
                icon: SHORTCUT_ICONS[reason],
                draggable: false,
                favourite: favourites.has(page.id),
                shortcutOf: reason,
                tooltip: pathOf(page, input.allPages, input.allCategories),
            }),
        );
    }

    const categoryChildren = new Map<string, WikiCategoryDto[]>();
    for (const category of visibleCategories)
        push(categoryChildren, category.parentCategoryId ?? '', category);
    for (const bucket of categoryChildren.values()) bucket.sort(byCategory);

    const pagesByCategory = new Map<string, WikiPageSummaryDto[]>();
    for (const page of visiblePages) push(pagesByCategory, page.categoryId ?? '', page);

    const treeStart = rows.length;
    const emit = (parentId: string, level: number): void => {
        for (const category of categoryChildren.get(parentId) ?? []) {
            const collapsed = input.collapsedIds.has(category.id);
            const children = pagesByCategory.get(category.id) ?? [];
            rows.push({
                kind: 'category',
                key: `c:${category.id}`,
                id: category.id,
                depth: level,
                level,
                title: category.name,
                labelKey: '',
                icon: CATEGORY_ICON,
                tooltip: category.name,
                focusable: true,
                draggable: input.canDrag,
                expandable: true,
                collapsed,
                favourite: false,
                pinned: false,
                category,
            });
            if (!collapsed) {
                appendPages(rows, children, level + 1, input, favourites);
                if (children.length === 0) {
                    rows.push(
                        labelRow('empty', `e:${category.id}`, 'WIKI.NAV.NO_PAGES_IN_CATEGORY', level + 1),
                    );
                }
            }
            emit(category.id, level + 1);
        }
    };
    emit('', 0);

    const loose = pagesByCategory.get('') ?? [];
    if (loose.length > 0) {
        if (rows.length > treeStart) rows.push(labelRow('header', 'h:loose', 'WIKI.NAV.PAGES', 0));
        appendPages(rows, loose, 0, input, favourites);
    }

    // A strip with nothing under it needs no rule beneath it.
    if (shortcuts.length > 0 && rows.length > shortcuts.length) {
        rows.splice(shortcuts.length, 0, labelRow('divider', 'd:shortcuts', '', 0));
    }
    return rows;
}

function appendPages(
    rows: NavRow[],
    group: readonly WikiPageSummaryDto[],
    level: number,
    input: NavRowInput,
    favourites: ReadonlySet<string>,
): void {
    const ids = new Set(group.map(p => p.id));
    const children = new Map<string, WikiPageSummaryDto[]>();
    const roots: WikiPageSummaryDto[] = [];
    for (const page of group) {
        // A page whose parent is filed elsewhere is a root here, or it would vanish from the tree.
        if (!page.parentPageId || !ids.has(page.parentPageId) || page.parentPageId === page.id) {
            roots.push(page);
        } else {
            push(children, page.parentPageId, page);
        }
    }
    roots.sort(byPage);
    for (const bucket of children.values()) bucket.sort(byPage);

    const walk = (page: WikiPageSummaryDto, depth: number): void => {
        rows.push(
            pageRow(page, {
                kind: 'page',
                key: `p:${page.id}`,
                depth,
                level: level + depth,
                icon: depth > 0 ? CHILD_PAGE_ICON : PAGE_ICON,
                draggable: input.canDrag,
                favourite: favourites.has(page.id),
                tooltip: pathOf(page, input.allPages, input.allCategories),
            }),
        );
        for (const child of children.get(page.id) ?? []) walk(child, depth + 1);
    };
    for (const root of roots) walk(root, 0);
}

interface PageRowParts {
    kind: NavRowKind;
    key: string;
    depth: number;
    level: number;
    icon: string;
    draggable: boolean;
    favourite: boolean;
    tooltip: string;
    shortcutOf?: ShortcutReason;
}

function pageRow(page: WikiPageSummaryDto, parts: PageRowParts): NavRow {
    return {
        kind: parts.kind,
        key: parts.key,
        id: page.id,
        depth: parts.depth,
        level: parts.level,
        title: page.title,
        labelKey: '',
        icon: parts.icon,
        tooltip: parts.tooltip,
        focusable: true,
        draggable: parts.draggable,
        expandable: false,
        collapsed: false,
        favourite: parts.favourite,
        pinned: page.isPinned,
        shortcutOf: parts.shortcutOf,
        page,
    };
}

function labelRow(kind: NavRowKind, key: string, labelKey: string, level: number): NavRow {
    return {
        kind,
        key,
        id: key,
        depth: level,
        level,
        title: '',
        labelKey,
        icon: '',
        tooltip: '',
        focusable: false,
        draggable: false,
        expandable: false,
        collapsed: false,
        favourite: false,
        pinned: false,
    };
}

function pathOf(
    page: WikiPageSummaryDto,
    pages: readonly WikiPageSummaryDto[],
    categories: readonly WikiCategoryDto[],
): string {
    return wikiPagePath(page.id, pages, categories).join(' / ');
}
