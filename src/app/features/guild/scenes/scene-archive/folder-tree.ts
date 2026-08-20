import {SceneFolderDto} from '../../../../dtos/response/scene.dto';

export interface FolderNode {
    folder: SceneFolderDto;
    children: FolderNode[];
    /** Scenes filed on this folder plus every scene filed anywhere below it. */
    count: number;
    /** Scenes filed on this folder alone, which is what clicking its row filters on. */
    ownCount: number;
}

/**
 * Builds the rail. A folder whose parent is missing is treated as a root: a half-applied delete
 * must not hide a guild's scenes.
 */
export function folderTree(
    folders: readonly SceneFolderDto[],
    countsByFolderId: Readonly<Record<string, number>>,
): FolderNode[] {
    const known = new Set(folders.map(f => f.id));
    const nodes = new Map<string, FolderNode>();

    for (const folder of folders) {
        const own = countsByFolderId[folder.id] ?? 0;
        nodes.set(folder.id, {folder, children: [], count: own, ownCount: own});
    }

    const roots: FolderNode[] = [];

    for (const folder of folders) {
        const node = nodes.get(folder.id)!;
        const parentId = folder.parentFolderId;
        const parent = parentId && known.has(parentId) ? nodes.get(parentId) : undefined;

        // A folder cannot parent itself, and one pointing at a folder that is gone comes back to
        // the root rather than vanishing with it.
        if (parent && parent !== node) {
            parent.children.push(node);
        } else {
            roots.push(node);
        }
    }

    for (const root of roots) settle(root);
    roots.sort(byPosition);

    return roots;
}

function byPosition(a: FolderNode, b: FolderNode): number {
    return a.folder.position - b.folder.position || a.folder.name.localeCompare(b.folder.name);
}

/** Sorts a level and rolls its counts up. Returns the subtree total. */
function settle(node: FolderNode): number {
    node.children.sort(byPosition);
    node.count = node.ownCount;
    for (const child of node.children) node.count += settle(child);
    return node.count;
}

/** How many scenes sit on each shelf, counted from the rows the archive is showing. */
export function countByFolder(scenes: readonly {folderId?: string | null}[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const scene of scenes) {
        if (!scene.folderId) continue;
        counts[scene.folderId] = (counts[scene.folderId] ?? 0) + 1;
    }
    return counts;
}
