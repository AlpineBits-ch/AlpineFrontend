import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {DeviceService} from './device.service';
import {ApiConfigService} from './api-config.service';

const BASE = 'https://api.test.example';
const URL = `${BASE}/api/v1/identity/devices`;

function setup() {
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
        ],
    });
    return {
        service: TestBed.inject(DeviceService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

describe('DeviceService.renameDevice', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    /**
     * An `identityPublicKey` in this body reads as a rotation on the server, which purges every
     * key package the device owns and orphans it from every MLS group it is in. A rename must
     * carry the two fields and nothing else.
     */
    it('posts only clientDeviceId and deviceName', () => {
        const {service, ctrl} = setup();
        service.renameDevice('device_1', 'Studio PC').subscribe();

        const req = ctrl.expectOne(URL);
        expect(req.request.method).toBe('POST');
        expect(Object.keys(req.request.body).sort()).toEqual(['clientDeviceId', 'deviceName']);
        expect(req.request.body).toEqual({clientDeviceId: 'device_1', deviceName: 'Studio PC'});
        req.flush({});
    });
});
