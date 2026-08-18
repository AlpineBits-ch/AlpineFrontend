import {describe, expect, it} from 'vitest';
import {SceneDto, SceneStatus} from '../../../dtos/response/scene.dto';
import {clockPressure, turnClock} from './scene-clock';

const NOW = Date.parse('2026-08-18T12:00:00Z');

function scene(extra: Partial<SceneDto> = {}): SceneDto {
    return {
        channelId: 'chan_1',
        guildId: 'guild_1',
        name: 'The Water Rising',
        status: SceneStatus.Active,
        participants: [{personaId: 'pers_a'}, {personaId: 'pers_b'}],
        turnOrder: ['pers_a', 'pers_b'],
        currentTurnPersonaId: 'pers_a',
        ...extra,
    };
}

function at(offsetHours: number): string {
    return new Date(NOW + offsetHours * 3_600_000).toISOString();
}

describe('turnClock', () => {
    it('has nothing to draw for a scene that is not running', () => {
        const clock = turnClock(scene({status: SceneStatus.Paused, turnDeadlineAt: at(4)}), NOW);
        expect(clock.hasDeadline).toBe(false);
        expect(clock.spent).toBeNull();
    });

    it('reports the fraction spent between the turn opening and its deadline', () => {
        const clock = turnClock(scene({turnStartedAt: at(-6), turnDeadlineAt: at(6)}), NOW);
        expect(clock.spent).toBeCloseTo(0.5);
        expect(clock.overdue).toBe(false);
        expect(clock.remainingMs).toBe(6 * 3_600_000);
    });

    // The turn's start is not in the locked API surface, so the last post stands in for it.
    it('falls back to the last post when the turn has no recorded start', () => {
        const clock = turnClock(scene({lastPostAt: at(-9), turnDeadlineAt: at(3)}), NOW);
        expect(clock.spent).toBeCloseTo(0.75);
    });

    it('claims no fraction at all when neither end is known', () => {
        const clock = turnClock(scene({turnDeadlineAt: at(3)}), NOW);
        expect(clock.hasDeadline).toBe(true);
        expect(clock.spent).toBeNull();
    });

    it('goes overdue rather than past full', () => {
        const clock = turnClock(scene({turnStartedAt: at(-48), turnDeadlineAt: at(-2)}), NOW);
        expect(clock.overdue).toBe(true);
        expect(clock.remainingMs).toBeLessThan(0);
        expect(clock.spent).toBe(1);
    });

    it('still measures how long a turn with no deadline has been open', () => {
        const clock = turnClock(scene({turnStartedAt: at(-30)}), NOW);
        expect(clock.hasDeadline).toBe(false);
        expect(clock.elapsedMs).toBe(30 * 3_600_000);
    });
});

describe('clockPressure', () => {
    it('is easy without a deadline, whatever the elapsed time', () => {
        expect(clockPressure(turnClock(scene({turnStartedAt: at(-400)}), NOW))).toBe('easy');
    });

    it('closes as the turn is spent, is due inside the last hour, and goes over', () => {
        expect(clockPressure(turnClock(scene({turnStartedAt: at(-40), turnDeadlineAt: at(8)}), NOW))).toBe(
            'closing',
        );
        expect(clockPressure(turnClock(scene({turnStartedAt: at(-47), turnDeadlineAt: at(0.5)}), NOW))).toBe(
            'due',
        );
        expect(clockPressure(turnClock(scene({turnStartedAt: at(-50), turnDeadlineAt: at(-2)}), NOW))).toBe(
            'over',
        );
    });
});
