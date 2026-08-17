import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {TestBed} from '@angular/core/testing';
import {
    HttpClient,
    HttpErrorResponse,
    HttpHeaders,
    provideHttpClient,
    withInterceptors,
} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {
    _resetRateLimitState,
    jittered,
    parseRetryAfter,
    rateLimitInterceptor,
} from './rate-limit-interceptor';

function tooManyRequests(body: unknown, headers?: Record<string, string>): HttpErrorResponse {
    return new HttpErrorResponse({
        status: 429,
        statusText: 'Too Many Requests',
        error: body,
        headers: headers ? new HttpHeaders(headers) : undefined,
    });
}

const TOO_MANY = {status: 429, statusText: 'Too Many Requests'};

function setupHttp() {
    TestBed.configureTestingModule({
        providers: [provideHttpClient(withInterceptors([rateLimitInterceptor])), provideHttpClientTesting()],
    });
    return {
        http: TestBed.inject(HttpClient),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

/** Advances the clock the interceptor reads and the timers it schedules, together. */
function tick(ms: number): void {
    vi.advanceTimersByTime(ms);
}

/** Answers whatever is still on the wire and runs out every pending backoff. */
function settle(ctrl: HttpTestingController): void {
    for (let i = 0; i < 8; i++) {
        ctrl.match(() => true).forEach(r => r.flush({}));
        tick(120_000);
    }
}

describe('parseRetryAfter', () => {
    beforeEach(() => _resetRateLimitState());

    /** `retry_after` is fractional seconds; `parseInt('0.42')` is 0. */
    it('keeps the fractional part of retry_after', () => {
        expect(parseRetryAfter(tooManyRequests({retry_after: 0.42, global: true}))).toBe(420);
    });

    it('does not round a sub-second wait down to nothing', () => {
        expect(parseRetryAfter(tooManyRequests({retry_after: 0.05}))).toBeGreaterThan(0);
    });

    it('handles whole-second values', () => {
        expect(parseRetryAfter(tooManyRequests({retry_after: 2}))).toBe(2000);
    });

    // The body is preferred over the header, which is only whole seconds.
    it('falls back to the Retry-After header when the body has no hint', () => {
        expect(parseRetryAfter(tooManyRequests({}, {'Retry-After': '3'}))).toBe(3000);
    });

    it('prefers the fractional body value over the rounded header', () => {
        expect(parseRetryAfter(tooManyRequests({retry_after: 0.5}, {'Retry-After': '1'}))).toBe(500);
    });

    it('falls back to a default when nothing is parseable', () => {
        expect(parseRetryAfter(tooManyRequests('rate limited'))).toBe(1000);
        expect(parseRetryAfter(tooManyRequests(null))).toBe(1000);
    });

    // A server asking us to sit out several minutes gets an error instead.
    it('clamps an absurd wait', () => {
        expect(parseRetryAfter(tooManyRequests({retry_after: 600}))).toBe(30_000);
    });

    it('treats a zero wait as immediate rather than as missing', () => {
        expect(parseRetryAfter(tooManyRequests({retry_after: 0}))).toBe(0);
    });

    it('ignores a negative wait', () => {
        expect(parseRetryAfter(tooManyRequests({retry_after: -5}))).toBe(1000);
    });

    it('returns null for anything that is not a 429', () => {
        expect(parseRetryAfter(new HttpErrorResponse({status: 500}))).toBeNull();
        expect(parseRetryAfter(new HttpErrorResponse({status: 403, error: {retry_after: 1}}))).toBeNull();
    });
});

describe('jittered', () => {
    /** The spread has to scale with the wait. */
    it('spreads a one-second wait across far more than the old fixed tail', () => {
        const samples = Array.from({length: 200}, () => jittered(1000));
        expect(Math.min(...samples)).toBeGreaterThanOrEqual(1000);
        expect(Math.max(...samples)).toBeLessThanOrEqual(2000);
        expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(250);
    });

    it('still spreads a zero wait, so a burst of them does not resume in lockstep', () => {
        const samples = Array.from({length: 200}, () => jittered(0));
        expect(Math.max(...samples)).toBeGreaterThan(0);
        expect(Math.max(...samples)).toBeLessThanOrEqual(250);
    });

    // The wait is already clamped to 30s, so the spread needs a ceiling of its own.
    it('caps the spread on a long wait', () => {
        const samples = Array.from({length: 200}, () => jittered(30_000));
        expect(Math.max(...samples)).toBeLessThanOrEqual(32_000);
    });
});

/** Whether the backoff relieves a storm or joins it. These assert the count, not the outcome. */
describe('rateLimitInterceptor amplification', () => {
    beforeEach(() => {
        _resetRateLimitState();
        // The clock and the scheduled timers have to move together or the gate never opens.
        vi.useFakeTimers();
        // Deterministic timings. The spread is exercised in the `jittered` suite above.
        vi.spyOn(Math, 'random').mockReturnValue(0);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('turns one logical request into no more than three on the wire', () => {
        const {http, ctrl} = setupHttp();
        let failed = false;
        http.get('/x').subscribe({error: () => (failed = true)});

        let sent = 0;
        for (let round = 0; round < 6; round++) {
            const pending = ctrl.match('/x');
            sent += pending.length;
            pending.forEach(r => r.flush({retry_after: 0.5, global: true}, TOO_MANY));
            tick(120_000);
        }

        expect(sent).toBe(3);
        expect(failed).toBe(true);
        settle(ctrl);
    });

    it('backs off further on each attempt instead of retrying at the same cadence', () => {
        const {http, ctrl} = setupHttp();
        http.get('/x').subscribe({error: () => undefined});

        ctrl.expectOne('/x').flush({retry_after: 1, global: true}, TOO_MANY);

        // First backoff is the server's hint: one second.
        tick(999);
        ctrl.expectNone('/x');
        tick(1);
        ctrl.expectOne('/x').flush({retry_after: 1, global: true}, TOO_MANY);

        // Second is doubled, so the third attempt is not another shot inside the same second.
        tick(1999);
        ctrl.expectNone('/x');
        tick(1);
        ctrl.expectOne('/x').flush({retry_after: 1, global: true}, TOO_MANY);

        settle(ctrl);
    });

    it('holds a brand new request while the shared gate is closed', () => {
        const {http, ctrl} = setupHttp();
        http.get('/a').subscribe({error: () => undefined});
        ctrl.expectOne('/a').flush({retry_after: 2, global: true}, TOO_MANY);

        http.get('/b').subscribe({error: () => undefined});
        ctrl.expectNone('/b');

        tick(2000);
        expect(ctrl.match('/b').length).toBe(1);

        settle(ctrl);
    });

    /** The gate is re-read after every wait. */
    it('keeps a parked request parked when a later 429 pushes the gate further out', () => {
        const {http, ctrl} = setupHttp();
        http.get('/a').subscribe({error: () => undefined});
        http.get('/c').subscribe({error: () => undefined});
        const a = ctrl.expectOne('/a');
        const c = ctrl.expectOne('/c');

        a.flush({retry_after: 1, global: true}, TOO_MANY); // gate: t + 1000
        http.get('/b').subscribe({error: () => undefined});
        ctrl.expectNone('/b');

        tick(500);
        c.flush({retry_after: 5, global: true}, TOO_MANY); // gate: t + 5500

        tick(600); // past the deadline /b originally read
        ctrl.expectNone('/b');

        tick(4500); // past the deadline that replaced it
        expect(ctrl.match('/b').length).toBe(1);

        settle(ctrl);
    });

    it('does not retry or gate on errors that are not 429', () => {
        const {http, ctrl} = setupHttp();
        let status = 0;
        http.get('/x').subscribe({error: (e: HttpErrorResponse) => (status = e.status)});

        ctrl.expectOne('/x').flush({}, {status: 500, statusText: 'Server Error'});
        expect(status).toBe(500);

        http.get('/y').subscribe({error: () => undefined});
        expect(ctrl.match('/y').length).toBe(1);

        settle(ctrl);
    });
});
