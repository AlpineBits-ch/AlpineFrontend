import {describe, expect, it} from 'vitest';

import {leavesByFolder, RECENT_LIMIT, recentScenes, sceneLeaf} from './scene-leaf';
import {SceneListItemDto, SceneStatus} from '../../../dtos/response/scene.dto';

function scene(over: Partial<SceneListItemDto> = {}): SceneListItemDto {
    return {
        channelId: 'ch_1',
        name: 'The Ford at Dawn',
        status: SceneStatus.Active,
        ...over,
    };
}

const NOBODY: ReadonlySet<string> = new Set();

describe('sceneLeaf', () => {
    it('marks a scene waiting on a character the reader speaks as', () => {
        const leaf = sceneLeaf(scene({currentTurnPersonaId: 'p1'}), new Set(['p1']));

        expect(leaf.mine).toBe(true);
        expect(leaf.channelId).toBe('ch_1');
        expect(leaf.name).toBe('The Ford at Dawn');
    });

    it('does not mark a scene on somebody else', () => {
        expect(sceneLeaf(scene({currentTurnPersonaId: 'p9'}), new Set(['p1'])).mine).toBe(false);
    });
});

describe('leavesByFolder', () => {
    it('groups scenes under the folder they are filed on', () => {
        const grouped = leavesByFolder(
            [
                scene({channelId: 'a', folderId: 'f1'}),
                scene({channelId: 'b', folderId: 'f2'}),
                scene({channelId: 'c', folderId: 'f1'}),
            ],
            NOBODY,
        );

        expect(grouped['f1'].map(l => l.channelId)).toEqual(['a', 'c']);
        expect(grouped['f2'].map(l => l.channelId)).toEqual(['b']);
    });

    it('leaves an unfiled scene out entirely', () => {
        const grouped = leavesByFolder(
            [scene({channelId: 'a'}), scene({channelId: 'b', folderId: null})],
            NOBODY,
        );

        expect(Object.keys(grouped)).toEqual([]);
    });
});

describe('recentScenes', () => {
    it('puts a scene waiting on you above a newer one that is not', () => {
        const rows = recentScenes(
            [
                scene({channelId: 'newer', updatedAt: '2026-08-20T12:00:00Z'}),
                scene({channelId: 'mine', updatedAt: '2026-01-01T00:00:00Z', currentTurnPersonaId: 'p1'}),
            ],
            new Set(['p1']),
        );

        expect(rows.map(r => r.channelId)).toEqual(['mine', 'newer']);
    });

    it('orders everything else by what moved last', () => {
        const rows = recentScenes(
            [
                scene({channelId: 'old', updatedAt: '2026-01-01T00:00:00Z'}),
                scene({channelId: 'new', updatedAt: '2026-08-20T12:00:00Z'}),
                scene({channelId: 'mid', updatedAt: '2026-05-01T00:00:00Z'}),
            ],
            NOBODY,
        );

        expect(rows.map(r => r.channelId)).toEqual(['new', 'mid', 'old']);
    });

    it('falls back to when the scene was created', () => {
        const rows = recentScenes(
            [
                scene({channelId: 'created-later', createdAt: '2026-08-01T00:00:00Z'}),
                scene({channelId: 'created-earlier', createdAt: '2026-02-01T00:00:00Z'}),
            ],
            NOBODY,
        );

        expect(rows.map(r => r.channelId)).toEqual(['created-later', 'created-earlier']);
    });

    it('sinks a scene with no usable timestamp rather than throwing', () => {
        const rows = recentScenes(
            [
                scene({channelId: 'undated', updatedAt: 'not a date'}),
                scene({channelId: 'dated', updatedAt: '2026-08-20T12:00:00Z'}),
            ],
            NOBODY,
        );

        expect(rows.map(r => r.channelId)).toEqual(['dated', 'undated']);
    });

    it('stops at the limit', () => {
        const many = Array.from({length: 12}, (_, i) =>
            scene({channelId: `ch_${i}`, updatedAt: `2026-08-0${(i % 9) + 1}T00:00:00Z`}),
        );

        expect(recentScenes(many, NOBODY)).toHaveLength(RECENT_LIMIT);
        expect(recentScenes(many, NOBODY, 2)).toHaveLength(2);
    });

    it('does not reorder the array it was handed', () => {
        const input = [
            scene({channelId: 'a', updatedAt: '2026-01-01T00:00:00Z'}),
            scene({channelId: 'b', updatedAt: '2026-08-01T00:00:00Z'}),
        ];

        recentScenes(input, NOBODY);

        expect(input.map(s => s.channelId)).toEqual(['a', 'b']);
    });
});
