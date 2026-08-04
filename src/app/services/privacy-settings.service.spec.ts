import {describe, expect, it, beforeEach, afterEach} from 'vitest';
import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';

import {PrivacySettingsService} from './privacy-settings.service';
import {ApiConfigService} from './api-config.service';
import {ProfileService} from './profile.service';
import {
    DirectMessagePolicy,
    PRIVACY_SETTINGS_DEFAULTS,
    PrivacySettings,
} from '../models/privacy-settings.model';

const BASE = 'https://api.test.example/api/v1/identity/privacy-settings';

function serverRecord(overrides: Partial<PrivacySettings> = {}): PrivacySettings {
    return {...PRIVACY_SETTINGS_DEFAULTS, version: 3, ...overrides};
}

describe('PrivacySettingsService', () => {
    let service: PrivacySettingsService;
    let http: HttpTestingController;
    let ownProfile: ReturnType<typeof signal<{userId: string} | undefined>>;

    beforeEach(() => {
        ownProfile = signal<{userId: string} | undefined>(undefined);
        TestBed.configureTestingModule({
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
                {provide: ProfileService, useValue: {ownProfile}},
            ],
        });
        service = TestBed.inject(PrivacySettingsService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => http.verify());

    describe('loading', () => {
        it('starts idle and holds no opinion about the account', () => {
            expect(service.status()).toBe('idle');
            expect(service.isReady()).toBe(false);
        });

        it('reads the record and becomes ready', () => {
            service.refresh().subscribe();
            http.expectOne(BASE).flush(serverRecord({allowDataCollection: true}));

            expect(service.status()).toBe('ready');
            expect(service.settings().allowDataCollection).toBe(true);
            expect(service.settings().version).toBe(3);
        });

        it('goes to unavailable rather than pretending the defaults are the user\'s choices', () => {
            service.refresh().subscribe();
            http.expectOne(BASE).flush('nope', {status: 500, statusText: 'Server Error'});

            expect(service.status()).toBe('unavailable');
            expect(service.isReady()).toBe(false);
        });

        it('ensureLoaded does not issue a second read once ready', () => {
            service.refresh().subscribe();
            http.expectOne(BASE).flush(serverRecord());

            service.ensureLoaded();
            http.expectNone(BASE);
        });

        it('ensureLoaded retries after a failed load', () => {
            service.refresh().subscribe();
            http.expectOne(BASE).flush('', {status: 500, statusText: 'Server Error'});

            service.ensureLoaded();
            http.expectOne(BASE).flush(serverRecord());
            expect(service.status()).toBe('ready');
        });
    });

    describe('consent defaults', () => {
        it('reports no data-collection consent while the record is unknown', () => {
            expect(service.allowDataCollection()).toBe(false);
            expect(service.allowPersonalization()).toBe(false);
        });

        it('still reports no consent after a failed load', () => {
            service.refresh().subscribe();
            http.expectOne(BASE).flush('', {status: 503, statusText: 'Unavailable'});

            expect(service.allowDataCollection()).toBe(false);
        });

        it('reports consent only once the server has actually said so', () => {
            service.refresh().subscribe();
            http.expectOne(BASE).flush(serverRecord({allowDataCollection: true}));

            expect(service.allowDataCollection()).toBe(true);
        });

        it('keeps behaviour flags at their permissive server default while unknown', () => {
            // These only suppress the client's own emissions and the server enforces them anyway,
            // so an unreachable endpoint must not silently disable the feature.
            expect(service.sendTypingIndicators()).toBe(true);
            expect(service.allowPositionalVoiceCapture()).toBe(true);
        });

        it('honours a false behaviour flag once loaded', () => {
            service.refresh().subscribe();
            http.expectOne(BASE).flush(serverRecord({sendTypingIndicators: false}));

            expect(service.sendTypingIndicators()).toBe(false);
        });
    });

    describe('patching', () => {
        beforeEach(() => {
            service.refresh().subscribe();
            http.expectOne(BASE).flush(serverRecord());
        });

        it('sends only the named fields', () => {
            service.patch({allowDataCollection: true}).subscribe();

            const req = http.expectOne(BASE);
            expect(req.request.method).toBe('PATCH');
            expect(req.request.body).toEqual({allowDataCollection: true});
            req.flush(serverRecord({allowDataCollection: true, version: 4}));
        });

        it('applies the change optimistically before the server answers', () => {
            service.patch({allowDataCollection: true}).subscribe();
            expect(service.settings().allowDataCollection).toBe(true);

            http.expectOne(BASE).flush(serverRecord({allowDataCollection: true, version: 4}));
        });

        it('adopts the server\'s copy, including the new version', () => {
            service.patch({directMessagePolicy: DirectMessagePolicy.Nobody}).subscribe();
            http.expectOne(BASE).flush(serverRecord({directMessagePolicy: DirectMessagePolicy.Nobody, version: 9}));

            expect(service.settings().version).toBe(9);
            expect(service.settings().directMessagePolicy).toBe(DirectMessagePolicy.Nobody);
        });

        it('rolls the change back when the write fails', () => {
            const before = service.settings().allowDataCollection;
            service.patch({allowDataCollection: true}).subscribe({error: () => void 0});
            http.expectOne(BASE).flush('', {status: 500, statusText: 'Server Error'});

            expect(service.settings().allowDataCollection).toBe(before);
        });

        it('surfaces the error to the caller rather than swallowing it', () => {
            let errored = false;
            service.patch({allowDataCollection: true}).subscribe({error: () => (errored = true)});
            http.expectOne(BASE).flush('', {status: 500, statusText: 'Server Error'});

            expect(errored).toBe(true);
        });

        it('records the field when the server refuses it under the minor floor', () => {
            service.patch({directMessagePolicy: DirectMessagePolicy.Everyone}).subscribe({error: () => void 0});
            http.expectOne(BASE).flush(
                {code: 'minor_restriction'},
                {status: 403, statusText: 'Forbidden'},
            );

            expect(service.minorRestricted().has('directMessagePolicy')).toBe(true);
        });

        it('does not record a restriction for an ordinary failure', () => {
            service.patch({directMessagePolicy: DirectMessagePolicy.Everyone}).subscribe({error: () => void 0});
            http.expectOne(BASE).flush('', {status: 500, statusText: 'Server Error'});

            expect(service.minorRestricted().size).toBe(0);
        });
    });

    describe('account lifecycle', () => {
        it('forgets everything on reset', () => {
            service.refresh().subscribe();
            http.expectOne(BASE).flush(serverRecord({allowDataCollection: true}));

            service.reset();

            expect(service.status()).toBe('idle');
            expect(service.allowDataCollection()).toBe(false);
            expect(service.settings()).toEqual(PRIVACY_SETTINGS_DEFAULTS);
        });
    });
});
