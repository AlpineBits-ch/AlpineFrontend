import {describe, expect, it} from 'vitest';
import {SceneDto, SceneListItemDto, SceneStatus} from '../../../dtos/response/scene.dto';
import {compareScenes, isWaitingOnMe, queueFromCurrent, upNext} from './scene-status';
import {sceneTally} from './scene-tally';

const NOW = Date.parse('2026-08-18T12:00:00Z');

function scene(extra: Partial<SceneDto> = {}): SceneDto {
    return {
        channelId: 'chan_1',
        guildId: 'guild_1',
        name: 'The Water Rising',
        status: SceneStatus.Active,
        participants: ['pers_a', 'pers_b', 'pers_c'].map(personaId => ({personaId})),
        turnOrder: ['pers_a', 'pers_b', 'pers_c'],
        currentTurnPersonaId: 'pers_b',
        ...extra,
    };
}

describe('queueFromCurrent', () => {
    it('rotates so whoever is up comes first', () => {
        expect(queueFromCurrent(scene())).toEqual(['pers_b', 'pers_c', 'pers_a']);
    });

    it('leaves the order alone when nobody is up yet', () => {
        expect(queueFromCurrent(scene({currentTurnPersonaId: null}))).toEqual(['pers_a', 'pers_b', 'pers_c']);
    });
});

describe('upNext', () => {
    it('is the next character in the queue', () => {
        expect(upNext(scene())).toBe('pers_c');
    });

    // The server skips a turn for someone who declared an absence, so the rail must say the same.
    it('skips anyone who is away', () => {
        const away = scene({
            participants: [{personaId: 'pers_a'}, {personaId: 'pers_b'}, {personaId: 'pers_c', isAway: true}],
        });
        expect(upNext(away)).toBe('pers_a');
    });

    it('has nobody to name in a scene of one', () => {
        expect(upNext(scene({turnOrder: ['pers_b'], currentTurnPersonaId: 'pers_b'}))).toBeNull();
    });
});

describe('isWaitingOnMe', () => {
    it('is true when the turn belongs to a character the reader may speak as', () => {
        expect(isWaitingOnMe(scene(), new Set(['pers_b']))).toBe(true);
    });

    it('is false for somebody else’s character', () => {
        expect(isWaitingOnMe(scene(), new Set(['pers_a']))).toBe(false);
    });

    // A shared guild persona is played by several people, so it waits on all of them.
    it('is true for a shared character the reader holds a grant on', () => {
        const narrator = scene({currentTurnPersonaId: 'pers_narrator'});
        expect(isWaitingOnMe(narrator, new Set(['pers_narrator']))).toBe(true);
    });

    it('is false once the scene is no longer running', () => {
        expect(isWaitingOnMe(scene({status: SceneStatus.Paused}), new Set(['pers_b']))).toBe(false);
        expect(isWaitingOnMe(scene({status: SceneStatus.Concluded}), new Set(['pers_b']))).toBe(false);
    });
});

describe('compareScenes', () => {
    const speakable = new Set(['pers_b']);

    it('puts what is waiting on the reader first, whatever its clock', () => {
        const mine = scene({channelId: 'mine', turnDeadlineAt: new Date(NOW + 9e8).toISOString()});
        const urgent = scene({
            channelId: 'urgent',
            currentTurnPersonaId: 'pers_a',
            turnDeadlineAt: new Date(NOW + 1000).toISOString(),
        });
        expect([urgent, mine].sort((a, b) => compareScenes(a, b, speakable, NOW))[0].channelId).toBe('mine');
    });

    it('then orders by status, running before ended', () => {
        const ended = scene({channelId: 'ended', status: SceneStatus.Concluded, currentTurnPersonaId: null});
        const running = scene({channelId: 'running', currentTurnPersonaId: 'pers_a'});
        expect([ended, running].sort((a, b) => compareScenes(a, b, speakable, NOW))[0].channelId).toBe(
            'running',
        );
    });

    it('then by the tightest clock, and a scene without one sorts last', () => {
        const soon = scene({
            channelId: 'soon',
            currentTurnPersonaId: 'pers_a',
            turnDeadlineAt: new Date(NOW + 3_600_000).toISOString(),
        });
        const open = scene({channelId: 'open', currentTurnPersonaId: 'pers_a'});
        expect(
            [open, soon].sort((a, b) => compareScenes(a, b, speakable, NOW)).map(s => s.channelId),
        ).toEqual(['soon', 'open']);
    });
});

describe('sceneTally', () => {
    it('leaves out anything the server did not count', () => {
        expect(sceneTally(scene())).toEqual([{value: 3, labelKey: 'SCENE.TALLY.CHARACTERS'}]);
    });

    it('reads the span from creation to the ending, not to now', () => {
        const ended = scene({
            status: SceneStatus.Concluded,
            postCount: 306,
            turnNumber: 96,
            createdAt: new Date(NOW - 200 * 86_400_000).toISOString(),
            concludedAt: new Date(NOW - 40 * 86_400_000).toISOString(),
        });
        expect(sceneTally(ended)).toEqual([
            {value: 306, labelKey: 'SCENE.TALLY.POSTS'},
            {value: 3, labelKey: 'SCENE.TALLY.CHARACTERS'},
            {value: 96, labelKey: 'SCENE.TALLY.TURNS'},
            {value: 160, labelKey: 'SCENE.TALLY.DAYS'},
        ]);
    });

    it('measures a running scene against the clock it is handed', () => {
        const running = scene({createdAt: new Date(NOW - 10 * 86_400_000).toISOString()});

        expect(sceneTally(running, NOW)).toEqual([
            {value: 3, labelKey: 'SCENE.TALLY.CHARACTERS'},
            {value: 10, labelKey: 'SCENE.TALLY.DAYS'},
        ]);
        expect(sceneTally(running, NOW + 5 * 86_400_000)).toContainEqual({
            value: 15,
            labelKey: 'SCENE.TALLY.DAYS',
        });
    });
});

describe('board rows', () => {
    // The list route answers a lighter shape than a scene: a count, no cast, no rotation.
    function row(extra: Partial<SceneListItemDto> = {}): SceneListItemDto {
        return {
            channelId: 'chan_1',
            name: 'The Water Rising',
            status: SceneStatus.Active,
            currentTurnPersonaId: 'pers_b',
            participantCount: 3,
            ...extra,
        };
    }

    it('answers waiting-on-me without a cast to look through', () => {
        expect(isWaitingOnMe(row(), new Set(['pers_b']))).toBe(true);
        expect(isWaitingOnMe(row(), new Set(['pers_a']))).toBe(false);
    });

    it('orders rows the same way it orders scenes', () => {
        const rows = [
            row({channelId: 'later', name: 'Later', currentTurnPersonaId: 'pers_a'}),
            row({channelId: 'mine', name: 'Mine'}),
        ];
        expect(
            [...rows].sort((a, b) => compareScenes(a, b, new Set(['pers_b']), NOW)).map(r => r.channelId),
        ).toEqual(['mine', 'later']);
    });

    it('tallies a row from its cast count', () => {
        expect(sceneTally(row({postCount: 12}))).toEqual([
            {value: 12, labelKey: 'SCENE.TALLY.POSTS'},
            {value: 3, labelKey: 'SCENE.TALLY.CHARACTERS'},
        ]);
    });
});
