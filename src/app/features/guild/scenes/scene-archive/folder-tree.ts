import {SceneFolderDto} from '../../../../dtos/response/scene.dto';

export interface FolderNode {
    folder: SceneFolderDto;
    children: FolderNode[];
    /** Scenes filed directly here, plus everything in its children. */
    count: number;
    /** Filed directly here, which is what the folder's own row is filtered on. */
    ownCount: number;
}

/**
 * Builds the rail's two levels. A folder whose parent is missing is treated as a root: a
 * half-applied delete must not hide a guild's scenes.
 */
export function folderTree(
    folders: readonly SceneFolderDto[],
    countsByFolderId: Readonly<Record<string, number>>,
): FolderNode[] {
    const known = new Set(folders.map(f => f.id));
    const nodes = new Map<string, FolderNode>();

    for (const folder of folders) {
        nodes.set(folder.id, {
            folder,
            children: [],
            count: countsByFolderId[folder.id] ?? 0,
            ownCount: countsByFolderId[folder.id] ?? 0,
        });
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
            parent.count += node.count;
        } else {
            roots.push(node);
        }
    }

    const byPosition = (a: FolderNode, b: FolderNode) =>
        a.folder.position - b.folder.position || a.folder.name.localeCompare(b.folder.name);

    roots.sort(byPosition);
    for (const root of roots) root.children.sort(byPosition);

    return roots;
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
