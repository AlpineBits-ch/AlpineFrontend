import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {afterEach, describe, expect, it} from 'vitest';
import {EntitlementService} from './entitlement.service';
import {ApiConfigService} from './api-config.service';
import {signal} from '@angular/core';

const BASE = 'https://api.test.example';

function setup() {
    const baseUrl = signal(BASE);
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl}},
        ],
    });
    return {
        service: TestBed.inject(EntitlementService),
        ctrl: TestBed.inject(HttpTestingController),
        baseUrl,
    };
}

describe('EntitlementService', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('reads the caller own set', () => {
        const {service, ctrl} = setup();

        service.getMine().subscribe();

        const req = ctrl.expectOne(`${BASE}/api/v1/entitlements/me`);
        expect(req.request.method).toBe('GET');
        req.flush({});
    });

    it('reads one guild set', () => {
        const {service, ctrl} = setup();

        service.getForGuild('guild-1').subscribe();

        ctrl.expectOne(`${BASE}/api/v1/entitlements/guilds/guild-1`).flush({});
    });

    /**
     * This client is pointed at arbitrary instances at runtime, so a base URL captured once at
     * construction outlives the instance it was built for and asks the wrong server.
     */
    it('follows the instance the app is currently pointed at', () => {
        const {service, ctrl, baseUrl} = setup();
        baseUrl.set('https://selfhosted.example');

        service.getMine().subscribe();

        ctrl.expectOne('https://selfhosted.example/api/v1/entitlements/me').flush({});
    });
});
