import {bestSourceMatch} from './source-match';
import {ScreenSource} from '../services/rust-media.service';

function source(id: string, name: string, isMonitor = false): ScreenSource {
    return {id, name, isMonitor, thumbnail: '', width: 1920, height: 1080};
}

describe('bestSourceMatch', () => {
    it('matches an exact window title', () => {
        const sources = [
            source('1', 'Monitor 1', true),
            source('2', 'Microsoft Flight Simulator 2024'),
            source('3', 'Google Chrome'),
        ];
        expect(bestSourceMatch('Microsoft Flight Simulator 2024', sources)).toBe('2');
    });

    it('ignores case and punctuation', () => {
        const sources = [source('2', 'counter-strike 2')];
        expect(bestSourceMatch('Counter Strike 2', sources)).toBe('2');
    });

    it('matches through a trailing version suffix', () => {
        const sources = [source('2', 'Microsoft Flight Simulator 2024 - v1.2.3')];
        expect(bestSourceMatch('Microsoft Flight Simulator 2024', sources)).toBe('2');
    });

    /** Sharing a whole screen is a different decision from sharing one game. */
    it('never matches a monitor, however well it scores', () => {
        const sources = [source('1', 'Overwatch', true)];
        expect(bestSourceMatch('Overwatch', sources)).toBeNull();
    });

    it('returns null when nothing is close enough', () => {
        const sources = [source('1', 'Monitor 1', true), source('3', 'Google Chrome')];
        expect(bestSourceMatch('Microsoft Flight Simulator 2024', sources)).toBeNull();
    });

    /** A confident wrong guess is worse than none - the preselected window might be private. */
    it('refuses a partial-token coincidence', () => {
        const sources = [source('3', 'Microsoft Edge')];
        expect(bestSourceMatch('Microsoft Flight Simulator 2024', sources)).toBeNull();
    });

    it('returns null for an empty source list', () => {
        expect(bestSourceMatch('Anything', [])).toBeNull();
    });

    it('returns null when the activity name carries no usable tokens', () => {
        expect(bestSourceMatch('- .', [source('1', 'Something')])).toBeNull();
    });

    it('prefers the better of two candidates', () => {
        const sources = [
            source('1', 'Rocket League'),
            source('2', 'Rocket League - Main Menu'),
            source('3', 'Rocket'),
        ];
        expect(bestSourceMatch('Rocket League', sources)).toBe('1');
    });
});
