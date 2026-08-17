import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {GuildService} from './guild.service';
import {ApiConfigService} from './api-config.service';
import {SelfGuildMemberDto} from '../dtos/response/member.dto';

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
        const dto = {
            roles: [
                {roleId: 'r1', position: 0},
                {roleId: 'r2', position: 1},
            ],
        };
        service.reorderRoles('g1', dto).subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/roles/reorder`);
        expect(req.request.method).toBe('PATCH');
        expect(req.request.body).toEqual(dto);
        req.flush(null);
    });
});

describe('GuildService channel/category updates and permission overwrites', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('updateChannel PATCHes the plural /channels/{id} route with the full-replace body', () => {
        const {service, ctrl} = setup();
        const dto = {name: 'general', isAgeRestricted: false, isPrivate: false, slowModeSeconds: 5};
        service.updateChannel('c1', dto).subscribe();
        const req = ctrl.expectOne(`${BASE}/channels/c1`);
        expect(req.request.method).toBe('PATCH');
        expect(req.request.body).toEqual(dto);
        req.flush({});
    });

    it('upsertChannelRolePermission PUTs to /channels/{channelId}/permissions/roles/{roleId}', () => {
        const {service, ctrl} = setup();
        const dto = {allowPermissions: 'ViewChannel', denyPermissions: 'None'};
        service.upsertChannelRolePermission('c1', 'r1', dto).subscribe();
        const req = ctrl.expectOne(`${BASE}/channels/c1/permissions/roles/r1`);
        expect(req.request.method).toBe('PUT');
        expect(req.request.body).toEqual(dto);
        req.flush({});
    });

    it('upsertChannelMemberPermission PUTs to /channels/{channelId}/permissions/members/{memberId}', () => {
        const {service, ctrl} = setup();
        service
            .upsertChannelMemberPermission('c1', 'm1', {allowPermissions: 'None', denyPermissions: 'None'})
            .subscribe();
        const req = ctrl.expectOne(`${BASE}/channels/c1/permissions/members/m1`);
        expect(req.request.method).toBe('PUT');
        req.flush({});
    });

    it('deleteChannelRolePermission DELETEs by roleId', () => {
        const {service, ctrl} = setup();
        service.deleteChannelRolePermission('c1', 'r1').subscribe();
        const req = ctrl.expectOne(`${BASE}/channels/c1/permissions/roles/r1`);
        expect(req.request.method).toBe('DELETE');
        req.flush(null);
    });

    it('deleteChannelMemberPermission DELETEs by memberId', () => {
        const {service, ctrl} = setup();
        service.deleteChannelMemberPermission('c1', 'm1').subscribe();
        const req = ctrl.expectOne(`${BASE}/channels/c1/permissions/members/m1`);
        expect(req.request.method).toBe('DELETE');
        req.flush(null);
    });

    it('upsertCategoryRolePermission PUTs to /categories/{categoryId}/permissions/roles/{roleId}', () => {
        const {service, ctrl} = setup();
        service
            .upsertCategoryRolePermission('cat1', 'r1', {allowPermissions: 'None', denyPermissions: 'None'})
            .subscribe();
        const req = ctrl.expectOne(`${BASE}/categories/cat1/permissions/roles/r1`);
        expect(req.request.method).toBe('PUT');
        req.flush({});
    });

    it('deleteCategoryMemberPermission DELETEs by memberId', () => {
        const {service, ctrl} = setup();
        service.deleteCategoryMemberPermission('cat1', 'm1').subscribe();
        const req = ctrl.expectOne(`${BASE}/categories/cat1/permissions/members/m1`);
        expect(req.request.method).toBe('DELETE');
        req.flush(null);
    });
});

describe('GuildService threads and invite-by-code', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('createThread POSTs to /channels/{channelId}/threads', () => {
        const {service, ctrl} = setup();
        service.createThread('c1', {name: 'bug-123'}).subscribe();
        const req = ctrl.expectOne(`${BASE}/channels/c1/threads`);
        expect(req.request.method).toBe('POST');
        expect(req.request.body).toEqual({name: 'bug-123'});
        req.flush({});
    });

    it('getThreads GETs /channels/{channelId}/threads', () => {
        const {service, ctrl} = setup();
        service.getThreads('c1').subscribe();
        const req = ctrl.expectOne(`${BASE}/channels/c1/threads`);
        expect(req.request.method).toBe('GET');
        req.flush([]);
    });

    it('archiveThread PATCHes /threads/{threadId}/archive', () => {
        const {service, ctrl} = setup();
        service.archiveThread('t1').subscribe();
        const req = ctrl.expectOne(`${BASE}/threads/t1/archive`);
        expect(req.request.method).toBe('PATCH');
        req.flush(null);
    });

    it('getInviteByCode GETs /invites/code/{code}', () => {
        const {service, ctrl} = setup();
        service.getInviteByCode('ab12cd34').subscribe();
        const req = ctrl.expectOne(`${BASE}/invites/code/ab12cd34`);
        expect(req.request.method).toBe('GET');
        req.flush({});
    });
});

describe('GuildService systemChannelId', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('updateGuild PATCHes systemChannelId when provided', () => {
        const {service, ctrl} = setup();
        service.updateGuild('g1', {systemChannelId: 'chan_1'}).subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1`);
        expect(req.request.method).toBe('PATCH');
        expect(req.request.body).toEqual({systemChannelId: 'chan_1'});
        req.flush({});
    });

    it('updateGuild omits systemChannelId when not provided, leaving it unchanged', () => {
        const {service, ctrl} = setup();
        service.updateGuild('g1', {name: 'New Name'}).subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1`);
        expect(req.request.body).toEqual({name: 'New Name'});
        expect(req.request.body.systemChannelId).toBeUndefined();
        req.flush({});
    });
});

// ── Own-member cache ─────────────────────────────────────────────────────────

/** A `/guilds/{id}/me` row carrying only the fields these tests compare on. */
function selfMember(guildId: string, permissions: string): SelfGuildMemberDto {
    return {id: `mem_${guildId}`, guildId, permissions, roleMembers: []} as unknown as SelfGuildMemberDto;
}

/**
 * Reset the TestBed in a `finally`. A `verify()` that throws otherwise leaves the outstanding
 * request in the injector that the next test inherits, and one failure cascades through the file.
 */
function verifyAndReset() {
    try {
        TestBed.inject(HttpTestingController).verify();
    } finally {
        vi.useRealTimers();
        TestBed.resetTestingModule();
    }
}

describe('GuildService.getOwnMember caching', () => {
    afterEach(verifyAndReset);

    it('coalesces callers that arrive together into one request and hands each of them the row', () => {
        const {service, ctrl} = setup();
        const seen: SelfGuildMemberDto[] = [];

        // The shape of a guild open: five hosts subscribe inside one change-detection pass,
        // before any response exists for the cache to hold.
        for (let i = 0; i < 5; i++) service.getOwnMember('g1').subscribe(m => seen.push(m));

        // `expectOne` is the assertion: it throws if the burst put more than one on the wire.
        ctrl.expectOne(`${BASE}/guilds/g1/me`).flush(selfMember('g1', 'ManageGuild'));

        expect(seen).toHaveLength(5);
        expect(seen.every(m => m.permissions === 'ManageGuild')).toBe(true);
    });

    it('serves a caller that arrives after the first settled from cache, with no second request', () => {
        const {service, ctrl} = setup();
        service.getOwnMember('g1').subscribe();
        ctrl.expectOne(`${BASE}/guilds/g1/me`).flush(selfMember('g1', 'ManageGuild'));

        let row: SelfGuildMemberDto | undefined;
        service.getOwnMember('g1').subscribe(m => (row = m));

        ctrl.expectNone(`${BASE}/guilds/g1/me`);
        expect(row?.permissions).toBe('ManageGuild');
    });

    it('keys the cache by guild, so a second guild is fetched rather than answered with the first', () => {
        const {service, ctrl} = setup();
        service.getOwnMember('g1').subscribe();
        ctrl.expectOne(`${BASE}/guilds/g1/me`).flush(selfMember('g1', 'ManageGuild'));

        let row: SelfGuildMemberDto | undefined;
        service.getOwnMember('g2').subscribe(m => (row = m));

        ctrl.expectOne(`${BASE}/guilds/g2/me`).flush(selfMember('g2', 'ViewChannel'));
        expect(row?.permissions).toBe('ViewChannel');
    });

    it('caches nothing when the request fails, so the next caller retries', () => {
        const {service, ctrl} = setup();
        const errors: unknown[] = [];
        service.getOwnMember('g1').subscribe({error: e => errors.push(e)});
        ctrl.expectOne(`${BASE}/guilds/g1/me`).flush('nope', {status: 500, statusText: 'Server Error'});
        expect(errors).toHaveLength(1);

        let row: SelfGuildMemberDto | undefined;
        service.getOwnMember('g1').subscribe(m => (row = m));

        ctrl.expectOne(`${BASE}/guilds/g1/me`).flush(selfMember('g1', 'ManageGuild'));
        expect(row?.permissions).toBe('ManageGuild');
    });

    it('refetches once the entry has aged out, so a change nobody told us about cannot last', () => {
        vi.useFakeTimers();
        const {service, ctrl} = setup();
        service.getOwnMember('g1').subscribe();
        ctrl.expectOne(`${BASE}/guilds/g1/me`).flush(selfMember('g1', 'ManageGuild'));

        vi.advanceTimersByTime(31_000);

        let row: SelfGuildMemberDto | undefined;
        service.getOwnMember('g1').subscribe(m => (row = m));
        ctrl.expectOne(`${BASE}/guilds/g1/me`).flush(selfMember('g1', 'ViewChannel'));
        expect(row?.permissions).toBe('ViewChannel');
    });
});

describe('GuildService.invalidateOwnMember', () => {
    afterEach(verifyAndReset);

    /**
     * The regression this whole cache is one bad decision away from: `OwnMemberRevisionService`
     * exists to make a demotion take effect without a relaunch, and it delivers that by making
     * hosts re-read the row. A cache that survived the invalidation would answer every one of
     * those re-reads with the pre-demotion row and silently undo the fix.
     */
    it('makes the next call hit the network and return the NEW row after a demotion', () => {
        const {service, ctrl} = setup();
        service.getOwnMember('g1').subscribe();
        ctrl.expectOne(`${BASE}/guilds/g1/me`).flush(selfMember('g1', 'ManageGuild'));

        service.invalidateOwnMember('g1');

        let row: SelfGuildMemberDto | undefined;
        service.getOwnMember('g1').subscribe(m => (row = m));
        ctrl.expectOne(`${BASE}/guilds/g1/me`).flush(selfMember('g1', 'ViewChannel'));
        expect(row?.permissions).toBe('ViewChannel');
    });

    it('leaves other guilds cached when one guild is invalidated', () => {
        const {service, ctrl} = setup();
        service.getOwnMember('g1').subscribe();
        ctrl.expectOne(`${BASE}/guilds/g1/me`).flush(selfMember('g1', 'ManageGuild'));
        service.getOwnMember('g2').subscribe();
        ctrl.expectOne(`${BASE}/guilds/g2/me`).flush(selfMember('g2', 'ViewChannel'));

        service.invalidateOwnMember('g1');

        service.getOwnMember('g2').subscribe();
        ctrl.expectNone(`${BASE}/guilds/g2/me`);
        service.getOwnMember('g1').subscribe();
        ctrl.expectOne(`${BASE}/guilds/g1/me`).flush(selfMember('g1', 'ViewChannel'));
    });

    it('drops every guild when called with no id', () => {
        const {service, ctrl} = setup();
        service.getOwnMember('g1').subscribe();
        ctrl.expectOne(`${BASE}/guilds/g1/me`).flush(selfMember('g1', 'ManageGuild'));
        service.getOwnMember('g2').subscribe();
        ctrl.expectOne(`${BASE}/guilds/g2/me`).flush(selfMember('g2', 'ManageGuild'));

        service.invalidateOwnMember();

        service.getOwnMember('g1').subscribe();
        service.getOwnMember('g2').subscribe();
        ctrl.expectOne(`${BASE}/guilds/g1/me`).flush(selfMember('g1', 'ViewChannel'));
        ctrl.expectOne(`${BASE}/guilds/g2/me`).flush(selfMember('g2', 'ViewChannel'));
    });

    /**
     * The race the epoch counter exists for: a role change lands while the very first read is
     * still on the wire. That response was computed before the change, so it must not be written
     * to the cache behind the invalidation, and the caller that arrives after it must not be
     * handed the request that produced it.
     */
    it('does not let a response that was already in flight repopulate the cache it invalidated', () => {
        const {service, ctrl} = setup();
        service.getOwnMember('g1').subscribe();
        const stale = ctrl.expectOne(`${BASE}/guilds/g1/me`);

        service.invalidateOwnMember('g1');
        stale.flush(selfMember('g1', 'ManageGuild'));

        let row: SelfGuildMemberDto | undefined;
        service.getOwnMember('g1').subscribe(m => (row = m));
        ctrl.expectOne(`${BASE}/guilds/g1/me`).flush(selfMember('g1', 'ViewChannel'));
        expect(row?.permissions).toBe('ViewChannel');
    });
});

describe('GuildService own-member invalidation on mutations', () => {
    afterEach(verifyAndReset);

    /** Warms the cache for `guildId` and asserts nothing else is outstanding. */
    function warm(service: GuildService, ctrl: HttpTestingController, guildId = 'g1') {
        service.getOwnMember(guildId).subscribe();
        ctrl.expectOne(`${BASE}/guilds/${guildId}/me`).flush(selfMember(guildId, 'ManageGuild'));
    }

    it('leaveGuild drops the row, so rejoining cannot be served the membership that ended', () => {
        const {service, ctrl} = setup();
        warm(service, ctrl);

        service.leaveGuild('g1').subscribe();
        ctrl.expectOne(`${BASE}/guilds/g1/members/me`).flush(null);

        service.getOwnMember('g1').subscribe();
        ctrl.expectOne(`${BASE}/guilds/g1/me`).flush(selfMember('g1', 'ViewChannel'));
    });

    it('kickMember drops the row - the member it removed may have been us', () => {
        const {service, ctrl} = setup();
        warm(service, ctrl);

        service.kickMember('g1', 'm1').subscribe();
        ctrl.expectOne(`${BASE}/guilds/g1/members/m1`).flush(null);

        service.getOwnMember('g1').subscribe();
        ctrl.expectOne(`${BASE}/guilds/g1/me`).flush(selfMember('g1', 'ViewChannel'));
    });

    it('updateMemberPermissions drops the row', () => {
        const {service, ctrl} = setup();
        warm(service, ctrl);

        service.updateMemberPermissions('g1', 'm1', 'ManageGuild').subscribe();
        // The path is asserted rather than just matched loosely: this spec previously agreed with
        // the service on a route the server has never had, so both were wrong together and the
        // screen 404'd with a green suite.
        const req = ctrl.expectOne(`${BASE}/guilds/g1/members/m1/permissions`);
        expect(req.request.method).toBe('PATCH');
        expect(req.request.body).toEqual({allowPermissions: 'ManageGuild'});
        req.flush({});

        service.getOwnMember('g1').subscribe();
        ctrl.expectOne(`${BASE}/guilds/g1/me`).flush(selfMember('g1', 'ViewChannel'));
    });

    it('a mutation that failed keeps the cache - nothing changed server-side', () => {
        const {service, ctrl} = setup();
        warm(service, ctrl);

        service.updateMemberPermissions('g1', 'm1', 'ManageGuild').subscribe({error: () => undefined});
        ctrl.expectOne(`${BASE}/guilds/g1/members/m1/permissions`).flush('no', {
            status: 403,
            statusText: 'Forbidden',
        });

        service.getOwnMember('g1').subscribe();
        ctrl.expectNone(`${BASE}/guilds/g1/me`);
    });

    it('assignRoleToMember drops every guild - the route names no guild to narrow it to', () => {
        const {service, ctrl} = setup();
        warm(service, ctrl, 'g1');
        warm(service, ctrl, 'g2');

        service.assignRoleToMember('r1', 'm1').subscribe();
        ctrl.expectOne(`${BASE}/roles/r1/members/m1`).flush(null);

        service.getOwnMember('g1').subscribe();
        service.getOwnMember('g2').subscribe();
        ctrl.expectOne(`${BASE}/guilds/g1/me`).flush(selfMember('g1', 'ViewChannel'));
        ctrl.expectOne(`${BASE}/guilds/g2/me`).flush(selfMember('g2', 'ViewChannel'));
    });

    it('removeRoleFromMember drops every guild', () => {
        const {service, ctrl} = setup();
        warm(service, ctrl);

        service.removeRoleFromMember('r1', 'm1').subscribe();
        ctrl.expectOne(`${BASE}/roles/r1/members/m1`).flush(null);

        service.getOwnMember('g1').subscribe();
        ctrl.expectOne(`${BASE}/guilds/g1/me`).flush(selfMember('g1', 'ViewChannel'));
    });

    it('updateRole drops every guild - a role we hold can change under us', () => {
        const {service, ctrl} = setup();
        warm(service, ctrl);

        service.updateRole('r1', {permissions: 'ManageGuild'}).subscribe();
        ctrl.expectOne(`${BASE}/roles/r1`).flush(null);

        service.getOwnMember('g1').subscribe();
        ctrl.expectOne(`${BASE}/guilds/g1/me`).flush(selfMember('g1', 'ViewChannel'));
    });

    it('updateGuild drops the row - the module set clamps effectivePermissions', () => {
        const {service, ctrl} = setup();
        warm(service, ctrl);

        service.updateGuild('g1', {features: 'Wiki'}).subscribe();
        ctrl.expectOne(`${BASE}/guilds/g1`).flush({});

        service.getOwnMember('g1').subscribe();
        ctrl.expectOne(`${BASE}/guilds/g1/me`).flush(selfMember('g1', 'ViewChannel'));
    });

    it('createRole keeps the cache - a role created empty grants nobody anything', () => {
        const {service, ctrl} = setup();
        warm(service, ctrl);

        service.createRole({guildId: 'g1', name: 'Mods'}).subscribe();
        ctrl.expectOne(`${BASE}/guilds/g1/roles`).flush({});

        service.getOwnMember('g1').subscribe();
        ctrl.expectNone(`${BASE}/guilds/g1/me`);
    });
});
