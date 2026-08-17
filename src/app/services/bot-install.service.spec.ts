import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {BotInstallService} from './bot-install.service';
import {ApiConfigService} from './api-config.service';

const BASE = 'https://api.test.example/api/v1/bots';

function setup() {
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
        ],
    });
    return {
        service: TestBed.inject(BotInstallService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

describe('BotInstallService', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('getManageableGuilds GETs /guilds/manageable with clientId as a query param', () => {
        const {service, ctrl} = setup();
        service.getManageableGuilds('client_1').subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/manageable?clientId=client_1`);
        expect(req.request.method).toBe('GET');
        req.flush([]);
    });

    it('getAuthorizeInfo GETs /oauth2/authorize with clientId, permissions and guildId as query params', () => {
        const {service, ctrl} = setup();
        service.getAuthorizeInfo('client_1', 513n, 'guild_1').subscribe();
        const req = ctrl.expectOne(
            `${BASE}/oauth2/authorize?clientId=client_1&permissions=513&guildId=guild_1`,
        );
        expect(req.request.method).toBe('GET');
        req.flush({
            applicationId: 'client_1',
            name: 'Bot',
            iconUrl: '',
            description: '',
            guildId: 'guild_1',
            requestedPermissions: '513',
            grantablePermissions: '513',
        });
    });

    it('authorize POSTs to /oauth2/authorize with the dto as the body', () => {
        const {service, ctrl} = setup();
        const dto = {clientId: 'client_1', guildId: 'guild_1', permissions: '513'};
        service.authorize(dto).subscribe();
        const req = ctrl.expectOne(`${BASE}/oauth2/authorize`);
        expect(req.request.method).toBe('POST');
        expect(req.request.body).toEqual(dto);
        req.flush({guildId: 'guild_1', grantedPermissions: '513'});
    });
});
