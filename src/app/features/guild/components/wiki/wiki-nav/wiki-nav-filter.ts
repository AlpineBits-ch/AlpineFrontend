/**
 * In-place narrowing of the nav tree, distinct from ⌘K: the palette navigates *away*, this one
 * keeps you where you are and hides rows that don't matter, which is why it keeps ancestors of
 * every match so a filtered tree stays a tree instead of becoming a flat list.
 */

export interface FilterableCategory {
    id: string;
    name: string;
    parentCategoryId?: string;
}

export interface FilterablePage {
    id: string;
    title: string;
    tags?: readonly string[];
    parentPageId?: string;
    categoryId?: string;
}

export interface NavFilterResult {
    pageIds: ReadonlySet<string>;
    categoryIds: ReadonlySet<string>;
}

function contains(text: string, needle: string): boolean {
    return text.toLowerCase().includes(needle);
}

/** Returns the ids still worth rendering, or `null` when there is no filter at all, so the caller skips every set lookup instead of testing membership against "everything". */
export function narrowNav(
    categories: readonly FilterableCategory[],
    pages: readonly FilterablePage[],
    filter: string,
): NavFilterResult | null {
    const needle = filter.trim().toLowerCase();
    if (!needle) return null;

    const categoryParent = new Map(categories.map(c => [c.id, c.parentCategoryId]));
    const pageParent = new Map(pages.map(p => [p.id, p.parentPageId]));

    // A category whose own name matches keeps everything under it: the user asked for that section, not for the rows inside it that happen to repeat its name.
    const matchedCategoryIds = new Set(categories.filter(c => contains(c.name, needle)).map(c => c.id));
    const withDescendantCategories = new Set(matchedCategoryIds);
    for (const category of categories) {
        let current: string | undefined = category.parentCategoryId;
        const seen = new Set<string>();
        while (current && !seen.has(current)) {
            seen.add(current);
            if (matchedCategoryIds.has(current)) {
                withDescendantCategories.add(category.id);
                break;
            }
            current = categoryParent.get(current);
        }
    }

    const pageIds = new Set<string>();
    for (const page of pages) {
        const self = contains(page.title, needle)
            || (page.tags ?? []).some(tag => contains(tag, needle))
            || (!!page.categoryId && withDescendantCategories.has(page.categoryId));
        if (!self) continue;
        pageIds.add(page.id);
        // Ancestors come along so a nested hit is still reachable from its root row.
        let current: string | undefined = pageParent.get(page.id);
        const seen = new Set<string>([page.id]);
        while (current && !seen.has(current)) {
            seen.add(current);
            pageIds.add(current);
            current = pageParent.get(current);
        }
    }

    const categoryIds = new Set<string>(withDescendantCategories);
    for (const page of pages) {
        if (page.categoryId && pageIds.has(page.id)) categoryIds.add(page.categoryId);
    }
    // Parent categories of a surviving category, for the same reason pages keep theirs.
    for (const id of [...categoryIds]) {
        let current: string | undefined = categoryParent.get(id);
        const seen = new Set<string>([id]);
        while (current && !seen.has(current)) {
            seen.add(current);
            categoryIds.add(current);
            current = categoryParent.get(current);
        }
    }

    return {pageIds, categoryIds};
}
