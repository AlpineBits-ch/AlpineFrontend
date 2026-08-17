import {describe, expect, it} from 'vitest';
import {
    formatMinuteOfDay,
    isMinuteWithinWindow,
    isWithinQuietHours,
    minuteOfDayIn,
    parseMinuteOfDay,
    validateQuietHours,
    windowLengthMinutes,
} from './quiet-hours';
import {QuietHoursDto} from '../../dtos/response/quiet-hours.dto';

function config(overrides: Partial<QuietHoursDto> = {}): QuietHoursDto {
    return {
        enabled: true,
        startMinuteLocal: 22 * 60,
        endMinuteLocal: 7 * 60,
        timeZoneId: 'Europe/Zurich',
        ...overrides,
    };
}

describe('isMinuteWithinWindow - same-day window', () => {
    const start = 13 * 60; // 13:00
    const end = 15 * 60;   // 15:00

    it('includes the start minute and excludes the end minute', () => {
        expect(isMinuteWithinWindow(start, end, start)).toBe(true);
        expect(isMinuteWithinWindow(start, end, end)).toBe(false);
    });

    it('is true inside and false outside', () => {
        expect(isMinuteWithinWindow(start, end, 14 * 60)).toBe(true);
        expect(isMinuteWithinWindow(start, end, 12 * 60 + 59)).toBe(false);
        expect(isMinuteWithinWindow(start, end, 15 * 60 + 1)).toBe(false);
    });
});

describe('isMinuteWithinWindow - wrapped window (22:00 -> 07:00)', () => {
    const start = 22 * 60; // 1320
    const end = 7 * 60;    // 420

    it('is true late in the evening, before midnight', () => {
        expect(isMinuteWithinWindow(start, end, 22 * 60)).toBe(true);
        expect(isMinuteWithinWindow(start, end, 23 * 60 + 59)).toBe(true);
    });

    it('is true across midnight and into the small hours', () => {
        expect(isMinuteWithinWindow(start, end, 0)).toBe(true);
        expect(isMinuteWithinWindow(start, end, 3 * 60)).toBe(true);
        expect(isMinuteWithinWindow(start, end, 6 * 60 + 59)).toBe(true);
    });

    it('ends exactly at the end minute', () => {
        expect(isMinuteWithinWindow(start, end, 7 * 60)).toBe(false);
    });

    it('is false through the middle of the day - the naive start<=m<end test reports this as never quiet', () => {
        expect(isMinuteWithinWindow(start, end, 12 * 60)).toBe(false);
        expect(isMinuteWithinWindow(start, end, 21 * 60 + 59)).toBe(false);
    });
});

describe('isMinuteWithinWindow - degenerate window', () => {
    it('treats start === end as no window rather than a 24-hour one', () => {
        expect(isMinuteWithinWindow(600, 600, 600)).toBe(false);
        expect(isMinuteWithinWindow(600, 600, 0)).toBe(false);
    });
});

describe('windowLengthMinutes', () => {
    it('measures a same-day window directly', () => {
        expect(windowLengthMinutes(13 * 60, 15 * 60)).toBe(120);
    });

    it('measures a wrapped window the long way round', () => {
        expect(windowLengthMinutes(22 * 60, 7 * 60)).toBe(9 * 60);
    });
});

describe('isWithinQuietHours', () => {
    it('answers false whenever the window is disabled, wrap or not', () => {
        const at = new Date('2026-01-15T02:00:00Z');
        expect(isWithinQuietHours(config({enabled: false}), at)).toBe(false);
    });

    it('uses the guild time zone, not the runtime one', () => {
        // 22:30 UTC is 23:30 in Zurich (inside 22:00-07:00) and 14:30 in Los Angeles (outside).
        const at = new Date('2026-01-15T22:30:00Z');
        expect(isWithinQuietHours(config({timeZoneId: 'Europe/Zurich'}), at)).toBe(true);
        expect(isWithinQuietHours(config({timeZoneId: 'America/Los_Angeles'}), at)).toBe(false);
    });

    it('holds across midnight in the guild zone', () => {
        // 01:00 UTC is 02:00 in Zurich - the far side of the wrap.
        expect(isWithinQuietHours(config(), new Date('2026-01-15T01:00:00Z'))).toBe(true);
    });

    it('is false at the exact end of the window', () => {
        // 06:00 UTC is 07:00 in Zurich.
        expect(isWithinQuietHours(config(), new Date('2026-01-15T06:00:00Z'))).toBe(false);
    });

    it('follows the zone through DST rather than a fixed offset', () => {
        // Zurich is UTC+1 in January, UTC+2 in July; the July case is the one a cached winter offset would get wrong.
        expect(isWithinQuietHours(config(), new Date('2026-01-15T20:30:00Z'))).toBe(false);
        expect(isWithinQuietHours(config(), new Date('2026-07-15T20:30:00Z'))).toBe(true);
    });

    it('answers false rather than throwing on a time zone this runtime rejects', () => {
        expect(isWithinQuietHours(config({timeZoneId: 'Mars/Olympus'}))).toBe(false);
    });
});

describe('minuteOfDayIn', () => {
    it('returns minutes past local midnight', () => {
        expect(minuteOfDayIn('UTC', new Date('2026-01-15T13:45:00Z'))).toBe(13 * 60 + 45);
    });

    it('reports midnight as 0, not 1440', () => {
        expect(minuteOfDayIn('UTC', new Date('2026-01-15T00:00:00Z'))).toBe(0);
    });

    it('returns null for an unknown zone', () => {
        expect(minuteOfDayIn('Nowhere/Nothing')).toBeNull();
    });
});

describe('formatMinuteOfDay / parseMinuteOfDay', () => {
    it('round-trips a time-of-day', () => {
        expect(formatMinuteOfDay(22 * 60)).toBe('22:00');
        expect(formatMinuteOfDay(7 * 60 + 5)).toBe('07:05');
        expect(parseMinuteOfDay('22:00')).toBe(1320);
        expect(parseMinuteOfDay('07:05')).toBe(425);
    });

    it('rejects nonsense rather than coercing it', () => {
        expect(parseMinuteOfDay('')).toBeNull();
        expect(parseMinuteOfDay('25:00')).toBeNull();
        expect(parseMinuteOfDay('12:60')).toBeNull();
        expect(parseMinuteOfDay(null)).toBeNull();
    });
});

describe('validateQuietHours', () => {
    it('accepts a wrapped window - it is the normal case, not an error', () => {
        expect(validateQuietHours(config())).toBeNull();
    });

    it('rejects an out-of-range minute at either end', () => {
        expect(validateQuietHours(config({startMinuteLocal: 1440}))).toBe('START_OUT_OF_RANGE');
        expect(validateQuietHours(config({startMinuteLocal: -1}))).toBe('START_OUT_OF_RANGE');
        expect(validateQuietHours(config({endMinuteLocal: 5000}))).toBe('END_OUT_OF_RANGE');
    });

    it('rejects a zero-length window', () => {
        expect(validateQuietHours(config({startMinuteLocal: 600, endMinuteLocal: 600})))
            .toBe('SAME_START_AND_END');
    });

    it('rejects an unknown IANA id', () => {
        expect(validateQuietHours(config({timeZoneId: 'Europe/Atlantis'}))).toBe('UNKNOWN_TIME_ZONE');
        expect(validateQuietHours(config({timeZoneId: ''}))).toBe('UNKNOWN_TIME_ZONE');
    });
});
