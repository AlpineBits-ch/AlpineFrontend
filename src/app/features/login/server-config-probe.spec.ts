/**
 * A cold start loses the first configuration probe often enough that one shot at it painted the
 * login card red for the rest of the session.
 */
import {HttpErrorResponse} from '@angular/common/http';
import {defer, firstValueFrom, Observable, of, throwError} from 'rxjs';
import {describeProbeFailure, retryTransient} from './server-config-probe';

const OFFLINE = new HttpErrorResponse({status: 0, statusText: 'Unknown Error'});
const UNAVAILABLE = new HttpErrorResponse({status: 503, statusText: 'Service Unavailable'});
const NOT_FOUND = new HttpErrorResponse({status: 404, statusText: 'Not Found'});

function failing(times: number, err: unknown) {
    let calls = 0;
    const obs: Observable<string> = defer(() => (calls++ < times ? throwError(() => err) : of('ok')));
    return {obs, calls: () => calls};
}

/** Settled either way, so a rejection is never unhandled while the timers are still running. */
function outcome<T>(source: Observable<T>) {
    return firstValueFrom(source.pipe(retryTransient())).then(
        value => ({value}),
        (err: unknown) => ({err}),
    );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the server configuration probe', () => {
    it('rides out two failed attempts', async () => {
        const source = failing(2, OFFLINE);

        const result = outcome(source.obs);
        await vi.advanceTimersByTimeAsync(5_000);

        expect(await result).toEqual({value: 'ok'});
        expect(source.calls()).toBe(3);
    });

    it('gives up after three attempts', async () => {
        const source = failing(99, OFFLINE);

        const result = outcome(source.obs);
        await vi.advanceTimersByTimeAsync(5_000);

        expect(await result).toEqual({err: OFFLINE});
        expect(source.calls()).toBe(3);
    });

    it('retries a gateway that is still coming up', async () => {
        const source = failing(1, UNAVAILABLE);

        const result = outcome(source.obs);
        await vi.advanceTimersByTimeAsync(5_000);

        expect(await result).toEqual({value: 'ok'});
        expect(source.calls()).toBe(2);
    });

    it('takes a 404 as an answer', async () => {
        const source = failing(99, NOT_FOUND);

        const result = outcome(source.obs);
        await vi.advanceTimersByTimeAsync(5_000);

        expect(await result).toEqual({err: NOT_FOUND});
        expect(source.calls()).toBe(1);
    });

    it('names the status, so the next report can tell the two sides apart', () => {
        expect(describeProbeFailure(OFFLINE)).toContain('0');
        expect(describeProbeFailure(new Error('store unavailable'))).toContain('store unavailable');
    });
});
