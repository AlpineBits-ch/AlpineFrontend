import {ActivityElapsedPipe} from './activity-elapsed.pipe';

const pipe = new ActivityElapsedPipe();

/** A round epoch to measure from, so the arithmetic in each case is readable. */
const START = 1_700_000_000_000;

function after(ms: number): string {
    return pipe.transform(START, START + ms);
}

describe('ActivityElapsedPipe', () => {
    it('counts seconds from the first one', () => {
        expect(after(0)).toBe('0:00');
        expect(after(1_000)).toBe('0:01');
        expect(after(59_000)).toBe('0:59');
    });

    it('rolls into minutes without padding them, matching the call timer', () => {
        expect(after(60_000)).toBe('1:00');
        expect(after(7 * 60_000 + 4_000)).toBe('7:04');
        expect(after(59 * 60_000 + 59_000)).toBe('59:59');
    });

    it('adds an hours field and pads the minutes only once there is one', () => {
        expect(after(3_600_000)).toBe('1:00:00');
        expect(after(3_600_000 + 2 * 60_000 + 33_000)).toBe('1:02:33');
        expect(after(25 * 3_600_000)).toBe('25:00:00');
    });

    it('truncates rather than rounds, so a timer never shows a second it has not reached', () => {
        expect(after(1_999)).toBe('0:01');
    });

    /**
     * The server can stamp `startedAt` a moment ahead of our corrected clock - the offset is only
     * accurate to about a second. "0:00" for that second is correct; "-0:01" is alarming.
     */
    it('clamps a start in the future to zero', () => {
        expect(pipe.transform(START, START - 5_000)).toBe('0:00');
    });

    it('renders nothing when there is no start, rather than the epoch', () => {
        expect(pipe.transform(null, START)).toBe('');
        expect(pipe.transform(undefined, START)).toBe('');
        expect(pipe.transform(Number.NaN, START)).toBe('');
    });
});
