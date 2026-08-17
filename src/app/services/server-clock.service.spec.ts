import {TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection} from '@angular/core';
import {ServerClockService} from './server-clock.service';

function setup(): ServerClockService {
    TestBed.configureTestingModule({providers: [provideZonelessChangeDetection()]});
    return TestBed.inject(ServerClockService);
}

describe('ServerClockService', () => {
    beforeEach(() => TestBed.resetTestingModule());
    afterEach(() => vi.useRealTimers());

    it('trusts the local clock until it has seen a response', () => {
        const clock = setup();

        expect(clock.trained()).toBe(false);
        expect(clock.offsetMs()).toBe(0);
    });

    it('adopts the difference between the server and the local midpoint of the round trip', () => {
        const clock = setup();

        // Request left at 1000, response back at 3000 -> local midpoint 2000. The server says
        // 12_000, so it is 10 s ahead of this machine.
        clock.adopt(12_000, 1_000, 3_000);

        expect(clock.offsetMs()).toBe(10_000);
        expect(clock.trained()).toBe(true);
    });

    /** Charging the whole round trip to the offset would make a slow request look like a clock error; halving it is the NTP assumption. */
    it('does not charge network latency to the offset', () => {
        const clock = setup();

        clock.adopt(5_000, 4_000, 6_000);

        expect(clock.offsetMs()).toBe(0);
    });

    it('ignores a correction smaller than the header can express', () => {
        const clock = setup();
        clock.adopt(12_000, 1_000, 3_000);

        // `Date` has one-second granularity; a 300 ms move is inside its noise floor and adopting
        // it would wake every consumer on every HTTP response.
        clock.adopt(12_300, 1_000, 3_000);

        expect(clock.offsetMs()).toBe(10_000);
    });

    it('adopts a correction big enough to matter', () => {
        const clock = setup();
        clock.adopt(12_000, 1_000, 3_000);

        clock.adopt(20_000, 1_000, 3_000);

        expect(clock.offsetMs()).toBe(18_000);
    });

    it('takes the very first reading however small, so a correct clock still counts as trained', () => {
        const clock = setup();

        clock.adopt(2_100, 1_000, 3_000);

        expect(clock.trained()).toBe(true);
        expect(clock.offsetMs()).toBe(100);
    });

    it('ignores an unparseable Date header rather than poisoning the offset with NaN', () => {
        const clock = setup();

        clock.adopt(Number.NaN, 1_000, 3_000);

        expect(clock.trained()).toBe(false);
        expect(clock.offsetMs()).toBe(0);
    });

    it('applies the offset to now(), which is the whole point', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(1_000_000));
        const clock = setup();

        clock.adopt(1_030_000, 1_000_000, 1_000_000);

        expect(clock.now()).toBe(1_030_000);
        expect(clock.elapsedSince(1_020_000)).toBe(10_000);
    });
});
