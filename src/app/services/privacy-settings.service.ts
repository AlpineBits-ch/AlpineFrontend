import {computed, effect, inject, Injectable, signal} from '@angular/core';
import {HttpClient, HttpErrorResponse} from '@angular/common/http';
import {catchError, Observable, of, tap, throwError} from 'rxjs';
import {ApiConfigService} from './api-config.service';
import {ProfileService} from './profile.service';
import {
    PRIVACY_REFUSAL_CODES,
    PRIVACY_SETTINGS_DEFAULTS,
    PrivacySettings,
    PrivacySettingsPatch,
} from '../models/privacy-settings.model';

/**
 * Whether the real record is known. `unavailable` (load failed) must stay distinct from
 * `ready`-with-defaults, or a privacy control renders as writable while nothing is stored.
 */
export type PrivacySettingsStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

/**
 * Reads a machine-readable refusal code out of whatever shape the API wrapped it in. Both `error`
 * and `code` must be read: the two refusal families use different field names.
 */
export function refusalCode(err: HttpErrorResponse): string | null {
    const body = err.error as {
        error?: unknown;
        code?: unknown;
        errorCode?: unknown;
        detail?: unknown;
    } | null;
    if (!body || typeof body !== 'object') return null;
    for (const candidate of [body.error, body.code, body.errorCode, body.detail]) {
        if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    }
    return null;
}

/**
 * The account's privacy record, the client half of §1.3/§1.4. Writes must be partial PATCHes and
 * never read-modify-write: two settings pages open at once would clobber each other's untouched
 * fields. Consumers gating on a flag read the computed signals here rather than fetching.
 */
@Injectable({providedIn: 'root'})
export class PrivacySettingsService {
    private http = inject(HttpClient);
    private apiConfig = inject(ApiConfigService);
    private profiles = inject(ProfileService);

    private readonly _settings = signal<PrivacySettings>({...PRIVACY_SETTINGS_DEFAULTS});
    private readonly _status = signal<PrivacySettingsStatus>('idle');
    private readonly _saving = signal(false);
    /** Fields the server refused under the minor floor, so the page can disable them and say why. */
    private readonly _minorRestricted = signal<ReadonlySet<string>>(new Set());

    /**
     * The record as last known. While {@link status} is not `ready` these are the model defaults
     * and must not be presented as the user's own settings.
     */
    readonly settings = this._settings.asReadonly();
    readonly status = this._status.asReadonly();
    readonly saving = this._saving.asReadonly();
    readonly minorRestricted = this._minorRestricted.asReadonly();

    readonly isReady = computed(() => this._status() === 'ready');

    /**
     * Consent to identified telemetry. Must default false until the record is known, so an
     * unreachable settings endpoint cannot be the reason an unconsented identifier gets sent.
     */
    readonly allowDataCollection = computed(() => this.isReady() && this._settings().allowDataCollection);
    readonly allowPersonalization = computed(() => this.isReady() && this._settings().allowPersonalization);

    /**
     * Behaviour flags that default true on the server. Until the record loads the client keeps the
     * server default; these only suppress the client's own emissions.
     */
    readonly sendTypingIndicators = computed(() => !this.isReady() || this._settings().sendTypingIndicators);
    readonly sendReadReceipts = computed(() => !this.isReady() || this._settings().sendReadReceipts);
    readonly allowPositionalVoiceCapture = computed(
        () => !this.isReady() || this._settings().allowPositionalVoiceCapture,
    );

    constructor() {
        // Loaded for the whole app, not just the settings page: it gates telemetry identity, typing
        // indicators and read receipts. Keyed to the profile so an account switch re-reads the new
        // account's record rather than leaving the previous one's consent in place.
        let lastUserId: string | null = null;
        effect(() => {
            const userId = this.profiles.ownProfile()?.userId ?? null;
            if (userId === lastUserId) return;
            lastUserId = userId;

            if (userId === null) this.reset();
            else this.refresh().subscribe();
        });
    }

    private get base(): string {
        return this.apiConfig.baseUrl() + '/api/v1/identity/privacy-settings';
    }

    /** Loads the record unless it is already loaded or in flight. */
    ensureLoaded(): void {
        if (this._status() === 'idle' || this._status() === 'unavailable') this.refresh().subscribe();
    }

    /** Re-reads the record from the server. Call after login and after an account switch. */
    refresh(): Observable<PrivacySettings | null> {
        this._status.set('loading');
        return this.http.get<PrivacySettings>(this.base).pipe(
            tap(settings => {
                this._settings.set(settings);
                this._status.set('ready');
            }),
            catchError(() => {
                this._status.set('unavailable');
                return of(null);
            }),
        );
    }

    /**
     * Writes the named fields and leaves every other one alone. Optimistic, rolled back on failure.
     * A `minor_restriction` refusal records the field so the page can disable it.
     */
    patch(patch: PrivacySettingsPatch): Observable<PrivacySettings> {
        const previous = this._settings();
        this._settings.set({...previous, ...patch});
        this._saving.set(true);

        return this.http.patch<PrivacySettings>(this.base, patch).pipe(
            tap(updated => {
                this._settings.set(updated);
                this._status.set('ready');
                this._saving.set(false);
            }),
            catchError((err: HttpErrorResponse) => {
                this._settings.set(previous);
                this._saving.set(false);
                if (refusalCode(err) === PRIVACY_REFUSAL_CODES.minorRestriction) {
                    this.recordMinorRestriction(Object.keys(patch));
                }
                return throwError(() => err);
            }),
        );
    }

    /** Forgets everything known about the account. Called on sign-out and account switch. */
    reset(): void {
        this._settings.set({...PRIVACY_SETTINGS_DEFAULTS});
        this._status.set('idle');
        this._saving.set(false);
        this._minorRestricted.set(new Set());
    }

    private recordMinorRestriction(fields: string[]): void {
        const next = new Set(this._minorRestricted());
        for (const field of fields) next.add(field);
        this._minorRestricted.set(next);
    }
}
