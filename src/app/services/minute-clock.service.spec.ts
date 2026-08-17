import {Component, inject} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {MinuteClockService} from './minute-clock.service';
import {ServerClockService} from './server-clock.service';

/** Stands in for the real clock so tests control "now" without touching wall time. */
class FakeServerClock {
    value = 1_000;

    now(): number {
        return this.value;
    }
}

/** A retainer has to live somewhere with a DestroyRef, which in practice means a component. */
@Component({template: ''})
class HostComponent {
    readonly clock = inject(MinuteClockService);

    constructor() {
        this.clock.retain();
    }
}

function setup() {
    const serverClock = new FakeServerClock();

    TestBed.configureTestingModule({
        imports: [HostComponent],
        providers: [{provide: ServerClockService, useValue: serverClock}],
    });

    return {serverClock, service: TestBed.inject(MinuteClockService)};
}

describe('MinuteClockService', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('does not tick until something retains it', () => {
        const {serverClock, service} = setup();

        serverClock.value = 5_000;
        vi.advanceTimersByTime(120_000);

        expect(service.now()).not.toBe(5_000);
    });

    it('samples the server clock on retain and every 30 seconds after', () => {
        const {serverClock, service} = setup();

        serverClock.value = 5_000;
        TestBed.createComponent(HostComponent);
        expect(service.now()).toBe(5_000);

        serverClock.value = 35_000;
        vi.advanceTimersByTime(30_000);
        expect(service.now()).toBe(35_000);
    });

    it('reads the server-corrected clock, not the local one', () => {
        const {serverClock, service} = setup();

        // A machine three hours fast still reports the server's idea of now.
        serverClock.value = Date.now() - 3 * 60 * 60 * 1000;
        TestBed.createComponent(HostComponent);

        expect(service.now()).toBe(serverClock.value);
    });

    it('stops ticking once the last retainer is destroyed', () => {
        const {serverClock, service} = setup();

        const fixture = TestBed.createComponent(HostComponent);
        vi.advanceTimersByTime(30_000);

        fixture.destroy();
        const frozen = service.now();

        serverClock.value = 999_000;
        vi.advanceTimersByTime(120_000);

        expect(service.now()).toBe(frozen);
    });

    it('keeps ticking while a second retainer is still alive', () => {
        const {serverClock, service} = setup();

        const first = TestBed.createComponent(HostComponent);
        TestBed.createComponent(HostComponent);

        first.destroy();
        serverClock.value = 77_000;
        vi.advanceTimersByTime(30_000);

        expect(service.now()).toBe(77_000);
    });
});
