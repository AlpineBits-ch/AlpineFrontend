import {describe, expect, it} from 'vitest';
import {HttpErrorResponse} from '@angular/common/http';
import {downloadErrorStatus} from './data-export.service';

/**
 * The download reaches the user through two shells - a native request on the desktop, an
 * `HttpClient` blob everywhere else - and both feed the same message picker. A status that fails to
 * survive the trip turns "that export has expired, request a new one" into "could not download that
 * export", which sends the user back to a button that will never work.
 */
describe('downloadErrorStatus', () => {
    it('reads the status of an HttpErrorResponse', () => {
        expect(downloadErrorStatus(new HttpErrorResponse({status: 410, statusText: 'Gone'})))
            .toBe(410);
    });

    it('reads the status the native command serialises', () => {
        expect(downloadErrorStatus({status: 409, message: 'export download answered 409 Conflict'}))
            .toBe(409);
    });

    // A blocked or dropped request is `status: 0` on the web side and `null` on the native side.
    // Neither says anything about the export, so both must land on the generic message rather than
    // being read as some status the caller then tries to interpret.
    it('reports no status for a transport failure from either shell', () => {
        expect(downloadErrorStatus(new HttpErrorResponse({status: 0, statusText: 'Unknown Error'})))
            .toBeNull();
        expect(downloadErrorStatus({status: null, message: 'error sending request'})).toBeNull();
    });

    it('reports no status for a rejection that carries none', () => {
        expect(downloadErrorStatus(new Error('boom'))).toBeNull();
        expect(downloadErrorStatus('Command download_data_export not found')).toBeNull();
        expect(downloadErrorStatus(null)).toBeNull();
        expect(downloadErrorStatus(undefined)).toBeNull();
    });
});
