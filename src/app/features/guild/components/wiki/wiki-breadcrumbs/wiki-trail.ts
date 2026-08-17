import {WikiDto} from '../../../../../dtos/response/wiki.dto';

export interface TrailSegment {
    id: string;
    label: string;
    kind: 'category' | 'page';
}

/**
 * Category, then ancestor pages outermost first, then the page itself. The parent walk is
 * cycle-guarded: cyclic parent data exists in practice, and an unguarded walk would spin forever
 * during a render.
 */
export function buildTrail(wiki: WikiDto | null, pageId: string | null): TrailSegment[] {
    if (!wiki || !pageId) return [];
    const byId = new Map(wiki.pages.map(p => [p.id, p]));
    const page = byId.get(pageId);
    if (!page) return [];

    const ancestors: TrailSegment[] = [];
    const visited = new Set<string>([page.id]);
    let current = page.parentPageId ? byId.get(page.parentPageId) : undefined;
    while (current && !visited.has(current.id)) {
        visited.add(current.id);
        ancestors.unshift({id: current.id, label: current.title, kind: 'page'});
        current = current.parentPageId ? byId.get(current.parentPageId) : undefined;
    }

    const category = page.categoryId
        ? wiki.categories.find(c => c.id === page.categoryId)
        : undefined;

    return [
        ...(category ? [{id: category.id, label: category.name, kind: 'category' as const}] : []),
        ...ancestors,
        {id: page.id, label: page.title, kind: 'page' as const},
    ];
}
