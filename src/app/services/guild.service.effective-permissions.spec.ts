import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {GuildService} from './guild.service';
import {ApiConfigService} from './api-config.service';

describe('GuildService permission reads', () => {
    let service: GuildService;
    let http: HttpTestingController;

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test'}},
            ],
        });

        service = TestBed.inject(GuildService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => http.verify());

    it('asks for a role subject by roleId', () => {
        service.getEffectivePermissions('chan_1', {kind: 'role', id: 'role_1'}).subscribe();

        const req = http.expectOne(
            'https://api.test/api/v1/guild/channels/chan_1/effective-permissions?roleId=role_1',
        );

        expect(req.request.method).toBe('GET');
        req.flush({channelId: 'chan_1', subjectKind: 'Role', subjectId: 'role_1', sources: []});
    });

    it('asks for a member subject by memberId', () => {
        service.getEffectivePermissions('chan_1', {kind: 'member', id: 'mem_1'}).subscribe();

        const req = http.expectOne(
            'https://api.test/api/v1/guild/channels/chan_1/effective-permissions?memberId=mem_1',
        );

        req.flush({channelId: 'chan_1', subjectKind: 'Member', subjectId: 'mem_1', sources: []});
    });

    it('posts an empty body to sync', () => {
        service.syncChannelPermissions('chan_1').subscribe();

        const req = http.expectOne('https://api.test/api/v1/guild/channels/chan_1/permissions/sync');

        expect(req.request.method).toBe('POST');
        expect(req.request.body).toEqual({});
        req.flush([]);
    });
});
