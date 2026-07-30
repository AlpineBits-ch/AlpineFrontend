import {inject, Injectable} from '@angular/core';
import {HttpClient, HttpErrorResponse} from '@angular/common/http';
import {catchError, from, map, Observable, of, throwError} from 'rxjs';
import {OAuthService, TokenResponse} from 'angular-oauth2-oidc';
import {ApiConfigService} from './api-config.service';
import {DeviceType} from '../dtos/response/user-device.dto';
import {StartQrLoginDto} from '../dtos/request/qr-login.dto';
import {QrLoginStartResponse, QrLoginStatus, QrLoginStatusResponse} from '../dtos/response/qr-login.dto';

/**
 * Custom OAuth grant the server exposes for redeeming an approved pairing code.
 * The code is spent server-side on first success, so this must never be retried.
 */
const QR_GRANT_TYPE = 'urn:echo:params:oauth:grant-type:qr_login';

/** How often the signing-in device asks the server whether the phone has acted yet. */
export const QR_POLL_INTERVAL_MS = 1500;

/**
 * `expired` is not a server status -it stands in for the 404 returned once the code's
 * three-minute window closes, which is otherwise indistinguishable from a code that
 * never existed. Kept separate from `denied` only so the UI can explain what happened.
 */
export type QrPollResult = QrLoginStatus | 'expired';

@Injectable({providedIn: 'root'})
export class QrLoginService {
    private http = inject(HttpClient);
    private oauthService = inject(OAuthService);
    private apiConfig = inject(ApiConfigService);

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/identity/qr-login';
    }

    /** Mints a pairing code valid for `expiresInSeconds`. Call again rather than reusing an expired one. */
    start(device: StartQrLoginDto = describeCurrentDevice()): Observable<QrLoginStartResponse> {
        return this.http.post<QrLoginStartResponse>(`${this.base}/start`, device);
    }

    /**
     * One poll tick. A 404 is folded into `expired` instead of erroring: the code
     * simply ageing out is the expected end of an unscanned pairing, not a failure.
     */
    status(code: string): Observable<QrPollResult> {
        return this.http.get<QrLoginStatusResponse>(`${this.base}/status/${encodeURIComponent(code)}`).pipe(
            map((res): QrPollResult => normalizeStatus(res.status)),
            catchError((err: unknown) => {
                if (err instanceof HttpErrorResponse && err.status === 404) return of<QrPollResult>('expired');
                return throwError(() => err);
            }),
        );
    }

    /**
     * Redeems an approved code for this device's own token pair -it does not copy the
     * approving phone's session. Only valid once `status` is `approved`; calling earlier
     * returns 401, and calling again after success fails because the code is spent.
     */
    exchange(code: string): Observable<TokenResponse> {
        return from(this.oauthService.fetchTokenUsingGrant(QR_GRANT_TYPE, {qr_code: code}));
    }
}

/**
 * The server answers PascalCase (`"Approved"`); the API guide documents lowercase. Comparing
 * the raw value against the lowercase names silently never matches, which strands an approved
 * pairing in an endless poll, so fold the case before anything downstream looks at it.
 *
 * An unrecognised value is reported as `expired` rather than kept in the poll loop: whatever
 * it means, this client cannot act on it, and that at least offers the user a new code.
 */
function normalizeStatus(raw: string): QrPollResult {
    switch (raw?.toLowerCase()) {
        case 'pending':
            return 'pending';
        case 'scanned':
            return 'scanned';
        case 'approved':
            return 'approved';
        case 'denied':
            return 'denied';
        default:
            return 'expired';
    }
}

/**
 * Best-effort label for the sessions list and the phone's confirmation prompt. Parsed from
 * the user agent rather than a native API so it works identically in the browser and inside
 * the Tauri webview, where a failed plugin call would otherwise leave the phone approving
 * an anonymous "unknown device".
 */
export function describeCurrentDevice(): StartQrLoginDto {
    const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
    const os = detectOs();

    if (isTauri) {
        return {deviceName: `Venta Desktop on ${os}`, deviceType: DeviceType.Desktop};
    }
    return {deviceName: `${detectBrowser()} on ${os}`, deviceType: DeviceType.Web};
}

function detectOs(): string {
    const ua = navigator.userAgent;
    if (/Windows NT 1[01]/.test(ua)) return 'Windows';
    if (/Windows/.test(ua)) return 'Windows';
    if (/Android/.test(ua)) return 'Android';
    // iPadOS reports as Macintosh; the touch-point check is the standard way to tell them apart.
    if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
    if (/Mac OS X/.test(ua)) return navigator.maxTouchPoints > 1 ? 'iPadOS' : 'macOS';
    if (/CrOS/.test(ua)) return 'ChromeOS';
    if (/Linux/.test(ua)) return 'Linux';
    return 'Unknown OS';
}

function detectBrowser(): string {
    const ua = navigator.userAgent;
    // Order matters: every Chromium browser also claims "Chrome", and Chrome claims "Safari".
    if (/Edg\//.test(ua)) return 'Edge';
    if (/OPR\//.test(ua)) return 'Opera';
    if (/Firefox\//.test(ua)) return 'Firefox';
    if (/Chrome\//.test(ua)) return 'Chrome';
    if (/Safari\//.test(ua)) return 'Safari';
    return 'Browser';
}
