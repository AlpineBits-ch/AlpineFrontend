import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {GuildService} from './guild.service';
import {ApiConfigService} from './api-config.service';

const BASE = 'https://api.test.example/api/v1/guild';

function setup() {
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
        ],
    });
    return {
        service: TestBed.inject(GuildService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

describe('GuildService bans', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('banMember POSTs to /guilds/{guildId}/bans with userId and reason in the body', () => {
        const {service, ctrl} = setup();
        service.banMember('g1', {userId: 'u1', reason: 'spam'}).subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/bans`);
        expect(req.request.method).toBe('POST');
        expect(req.request.body).toEqual({userId: 'u1', reason: 'spam'});
        req.flush(null);
    });

    it('banMember omits reason when not provided', () => {
        const {service, ctrl} = setup();
        service.banMember('g1', {userId: 'u1'}).subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/bans`);
        expect(req.request.body).toEqual({userId: 'u1'});
        req.flush(null);
    });

    it('getBans GETs the bans list', () => {
        const {service, ctrl} = setup();
        service.getBans('g1').subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/bans`);
        expect(req.request.method).toBe('GET');
        req.flush([]);
    });

    it('unbanMember DELETEs by userId', () => {
        const {service, ctrl} = setup();
        service.unbanMember('g1', 'u1').subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/bans/u1`);
        expect(req.request.method).toBe('DELETE');
        req.flush(null);
    });

    it('kickMember DELETEs the plural /guilds/{guildId}/members/{memberId} route', () => {
        const {service, ctrl} = setup();
        service.kickMember('g1', 'm1').subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/members/m1`);
        expect(req.request.method).toBe('DELETE');
        req.flush(null);
    });
});

describe('GuildService timeouts and leave', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('muteMember POSTs durationMinutes to the mute route', () => {
        const {service, ctrl} = setup();
        service.muteMember('g1', 'm1', 60).subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/members/m1/mute`);
        expect(req.request.method).toBe('POST');
        expect(req.request.body).toEqual({durationMinutes: 60});
        req.flush(null);
    });

    it('unmuteMember DELETEs the mute route', () => {
        const {service, ctrl} = setup();
        service.unmuteMember('g1', 'm1').subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/members/m1/mute`);
        expect(req.request.method).toBe('DELETE');
        req.flush(null);
    });

    it('leaveGuild DELETEs /guilds/{guildId}/members/me', () => {
        const {service, ctrl} = setup();
        service.leaveGuild('g1').subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/members/me`);
        expect(req.request.method).toBe('DELETE');
        req.flush(null);
    });
});

describe('GuildService audit log and role reorder', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('getAuditLog GETs with skip/take query params', () => {
        const {service, ctrl} = setup();
        service.getAuditLog('g1', 0, 50).subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/audit-log?skip=0&take=50`);
        expect(req.request.method).toBe('GET');
        req.flush([]);
    });

    it('reorderRoles PATCHes the roles array', () => {
        const {service, ctrl} = setup();
        const dto = {roles: [{roleId: 'r1', position: 0}, {roleId: 'r2', position: 1}]};
        service.reorderRoles('g1', dto).subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/roles/reorder`);
        expect(req.request.method).toBe('PATCH');
        expect(req.request.body).toEqual(dto);
        req.flush(null);
    });
});
