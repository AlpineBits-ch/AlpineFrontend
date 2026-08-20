/**
 * What a drop at a given point would do, decided before anything is drawn or written.
 *
 * `reorder` is category-only: pages carry no position field, so an insertion line between two page
 * rows would promise an order the model cannot store.
 */

export interface DropCategory {
    readonly id: string;
    readonly parentCategoryId?: string;
}

export interface DropPage {
    readonly id: string;
    readonly parentPageId?: string;
    readonly categoryId?: string;
}

export interface DropModel {
    readonly categories: readonly DropCategory[];
    readonly pages: readonly DropPage[];
}

export interface DragSource {
    readonly type: 'category' | 'page';
    readonly id: string;
}

export interface DropTarget {
    readonly type: 'category' | 'page';
    readonly id: string;
}

export type DropKind = 'reorder' | 'into' | 'nest' | 'none';

export type DropReason = 'self' | 'cycle' | 'different-parent' | 'not-a-target' | 'no-op' | 'missing';

export interface DropIntent {
    readonly kind: DropKind;
    readonly position?: 'before' | 'after';
    readonly reason?: DropReason;
}

const NONE = (reason: DropReason): DropIntent => ({kind: 'none', reason});

/** True when making `newParentId` the parent of `draggedId` would close a loop. */
export function wouldCreatePageCycle(
    draggedId: string,
    newParentId: string,
    pages: readonly DropPage[],
): boolean {
    if (newParentId === draggedId) return true;
    const parents = new Map(pages.map(p => [p.id, p.parentPageId]));
    const seen = new Set<string>();
    let current: string | undefined = newParentId;
    while (current && !seen.has(current)) {
        seen.add(current);
        const parent = parents.get(current);
        if (!parent) return false;
        if (parent === draggedId) return true;
        current = parent;
    }
    return false;
}

export function wouldCreateCategoryCycle(
    draggedId: string,
    targetId: string,
    categories: readonly DropCategory[],
): boolean {
    if (targetId === draggedId) return true;
    const parents = new Map(categories.map(c => [c.id, c.parentCategoryId]));
    const seen = new Set<string>();
    let current: string | undefined = targetId;
    while (current && !seen.has(current)) {
        seen.add(current);
        const parent = parents.get(current);
        if (!parent) return false;
        if (parent === draggedId) return true;
        current = parent;
    }
    return false;
}

/**
 * @param pointerOffset how far down the target row the pointer sits, 0 at its top edge, 1 at its bottom.
 */
export function dropIntent(
    dragging: DragSource | null,
    target: DropTarget | null,
    pointerOffset: number,
    wiki: DropModel,
): DropIntent {
    if (!dragging || !target) return NONE('missing');
    if (dragging.id === target.id) return NONE('self');

    if (dragging.type === 'category') {
        if (target.type !== 'category') return NONE('not-a-target');
        const dragged = wiki.categories.find(c => c.id === dragging.id);
        const onto = wiki.categories.find(c => c.id === target.id);
        if (!dragged || !onto) return NONE('missing');
        if (wouldCreateCategoryCycle(dragged.id, onto.id, wiki.categories)) return NONE('cycle');
        // Moving a category between parents is not offered; only its order among its siblings is.
        if ((dragged.parentCategoryId ?? null) !== (onto.parentCategoryId ?? null)) {
            return NONE('different-parent');
        }
        return {kind: 'reorder', position: pointerOffset < 0.5 ? 'before' : 'after'};
    }

    const dragged = wiki.pages.find(p => p.id === dragging.id);
    if (!dragged) return NONE('missing');

    if (target.type === 'category') {
        const onto = wiki.categories.find(c => c.id === target.id);
        if (!onto) return NONE('missing');
        // The whole header means "file it in here"; no half of a 24px row means anything else.
        if ((dragged.categoryId ?? null) === onto.id && !dragged.parentPageId) return NONE('no-op');
        return {kind: 'into'};
    }

    const onto = wiki.pages.find(p => p.id === target.id);
    if (!onto) return NONE('missing');
    if (wouldCreatePageCycle(dragged.id, onto.id, wiki.pages)) return NONE('cycle');
    if (
        (dragged.parentPageId ?? null) === onto.id &&
        (dragged.categoryId ?? null) === (onto.categoryId ?? null)
    ) {
        return NONE('no-op');
    }
    return {kind: 'nest'};
}
