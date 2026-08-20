import {describe, expect, it} from 'vitest';

import {countByFolder, folderTree} from './folder-tree';
import {SceneFolderDto} from '../../../../dtos/response/scene.dto';

function folder(
    id: string,
    name: string,
    parentFolderId: string | null = null,
    position = 0,
): SceneFolderDto {
    return {id, guildId: 'g1', name, position, parentFolderId};
}

describe('folderTree', () => {
    it('nests a child under its parent', () => {
        const tree = folderTree([folder('f1', 'Arc I'), folder('f2', 'Sidequests', 'f1')], {});

        expect(tree.map(n => n.folder.id)).toEqual(['f1']);
        expect(tree[0].children.map(n => n.folder.id)).toEqual(['f2']);
    });

    it('rolls a child count up into its parent but keeps the parent own count separate', () => {
        const tree = folderTree([folder('f1', 'Arc I'), folder('f2', 'Sidequests', 'f1')], {f1: 2, f2: 3});

        expect(tree[0].count).toBe(5);
        expect(tree[0].ownCount).toBe(2);
        expect(tree[0].children[0].count).toBe(3);
    });

    it('treats an orphan as a root rather than dropping it', () => {
        // A half-applied delete must never hide a guild's scenes.
        const tree = folderTree([folder('f9', 'Orphan', 'gone')], {});

        expect(tree.map(n => n.folder.id)).toEqual(['f9']);
    });

    it('treats a folder pointing at itself as a root', () => {
        const tree = folderTree([folder('f1', 'Loop', 'f1')], {});

        expect(tree.map(n => n.folder.id)).toEqual(['f1']);
        expect(tree[0].children).toEqual([]);
    });

    it('orders roots and children by position, then by name', () => {
        const tree = folderTree(
            [
                folder('f2', 'Arc II', null, 1),
                folder('f1', 'Arc I', null, 0),
                folder('c2', 'Beta', 'f1', 0),
                folder('c1', 'Alpha', 'f1', 0),
            ],
            {},
        );

        expect(tree.map(n => n.folder.id)).toEqual(['f1', 'f2']);
        expect(tree[0].children.map(n => n.folder.name)).toEqual(['Alpha', 'Beta']);
    });

    it('is empty when the guild has no folders', () => {
        expect(folderTree([], {})).toEqual([]);
    });
});

describe('countByFolder', () => {
    it('counts filed scenes and ignores unfiled ones', () => {
        const counts = countByFolder([{folderId: 'f1'}, {folderId: 'f1'}, {folderId: null}, {}]);

        expect(counts).toEqual({f1: 2});
    });
});
