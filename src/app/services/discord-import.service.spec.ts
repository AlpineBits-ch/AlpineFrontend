import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {DiscordImportService} from './discord-import.service';
import {ApiConfigService} from './api-config.service';

const BASE = 'https://api.test.example/api/v1/imports';

function setup() {
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
        ],
    });
    return {
        service: TestBed.inject(DiscordImportService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

describe('DiscordImportService', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('startImport GETs /discord/start', () => {
        const {service, ctrl} = setup();
        service.startImport().subscribe();
        const req = ctrl.expectOne(`${BASE}/discord/start`);
        expect(req.request.method).toBe('GET');
        req.flush({authorizeUrl: 'https://discord.com/oauth2/authorize?x=1'});
    });

    it('getJob GETs /jobs/{jobId}', () => {
        const {service, ctrl} = setup();
        service.getJob('job1').subscribe();
        const req = ctrl.expectOne(`${BASE}/jobs/job1`);
        expect(req.request.method).toBe('GET');
        req.flush({jobId: 'job1', status: 'Pending'});
    });

    it('getLinks GETs /links with guildId as a query param', () => {
        const {service, ctrl} = setup();
        service.getLinks('g1').subscribe();
        const req = ctrl.expectOne(r => r.url === `${BASE}/links` && r.params.get('guildId') === 'g1');
        expect(req.request.method).toBe('GET');
        req.flush([]);
    });

    it('setLinkStatus PATCHes /links/{linkId} with the new status', () => {
        const {service, ctrl} = setup();
        service.setLinkStatus('link1', 'Paused').subscribe();
        const req = ctrl.expectOne(`${BASE}/links/link1`);
        expect(req.request.method).toBe('PATCH');
        expect(req.request.body).toEqual({status: 'Paused'});
        req.flush({
            id: 'link1',
            guildId: 'g1',
            discordGuildId: 'd1',
            discordGuildName: 'D',
            status: 'Paused',
            syncDirection: 'DiscordToVenta',
            createdAt: '2026-01-01T00:00:00Z',
        });
    });

    it('unlink DELETEs /links/{linkId}', () => {
        const {service, ctrl} = setup();
        service.unlink('link1').subscribe();
        const req = ctrl.expectOne(`${BASE}/links/link1`);
        expect(req.request.method).toBe('DELETE');
        req.flush(null);
    });
});
