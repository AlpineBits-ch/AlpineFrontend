import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';

import {MfaService} from './mfa.service';
import {ApiConfigService} from './api-config.service';

describe('MfaService', () => {
    let service: MfaService;
    let http: HttpTestingController;

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            ],
        });
        service = TestBed.inject(MfaService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => http.verify());

    it('posts an empty body to the enroll endpoint', () => {
        service.enroll().subscribe();
        const req = http.expectOne('https://api.test.example/api/v1/identity/user/mfa/enroll');
        expect(req.request.method).toBe('POST');
        req.flush({secret: 'S', otpAuthUri: 'otpauth://totp/x'});
    });

    it('sends the code when enabling', () => {
        service.enable('123456').subscribe();
        const req = http.expectOne('https://api.test.example/api/v1/identity/user/mfa/enable');
        expect(req.request.body).toEqual({code: '123456'});
        req.flush({recoveryCodes: []});
    });

    it('sends the password when disabling', () => {
        service.disable('pw').subscribe();
        const req = http.expectOne('https://api.test.example/api/v1/identity/user/mfa/disable');
        expect(req.request.body).toEqual({password: 'pw'});
        req.flush({});
    });
});
