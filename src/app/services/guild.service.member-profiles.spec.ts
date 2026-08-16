/**
 * The member list already carries everybody's profile, and the app was throwing it away.
 *
 * <p>`GET /guilds/{id}/members` embeds a full `ProfileDto` per row - the server resolves them in one
 * batched bus call before it answers. Nothing fed those into {@link ProfileService}, so every
 * surface that needed a name for one of those same people - the voice roster in the sidebar, a
 * message header, an avatar - went and fetched it again, one request per user, against a rate limit
 * shared with everything else the launch is doing. A 429 there is not a failure the user sees; it is
 * the backoff ladder in `rateLimitInterceptor` turning one name into a five second wait.</p>
 *
 * <p>These profiles cost nothing: the response is already on the wire for another reason.</p>
 */
import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {afterEach, describe, expect, it} from 'vitest';
import {GuildService} from './guild.service';
import {ProfileService} from './profile.service';
import {ApiConfigService} from './api-config.service';
import {GuildMemberDto} from '../dtos/response/member.dto';
import {OnlineStatus, ProfileDto, ProfileFont} from '../dtos/response/profile.dto';

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
        // The real one, not a spy: what matters is that a later `getCachedByUserId` hits, which is
        // the thing every caller actually asks.
        profiles: TestBed.inject(ProfileService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

function profile(userId: string, userName: string): ProfileDto {
    return {
        id: `p_${userId}`,
        userId,
        userName,
        bio: undefined,
        avatarUrl: `https://cdn/${userId}.png`,
        bannerUrl: undefined,
        accentColor: null,
        font: ProfileFont.Default,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        updatedAt: new Date('2026-01-01T00:00:00Z'),
        onlineStatus: OnlineStatus.Online,
    };
}

function member(userId: string, embedded: ProfileDto | undefined): GuildMemberDto {
    return {
        id: `m_${userId}`,
        guildId: 'g1',
        userId,
        inviteId: '',
        status: OnlineStatus.Online,
        type: 0,
        nickname: null,
        profile: embedded,
        readState: [],
    } as unknown as GuildMemberDto;
}

describe('profiles embedded in the member list', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('seeds the profile cache from getMembers, so nothing refetches those users', () => {
        const {service, profiles, ctrl} = setup();

        service.getMembers('g1', 0, 100).subscribe();
        ctrl.expectOne(`${BASE}/guilds/g1/members?skip=0&take=100`)
            .flush([member('u1', profile('u1', 'Ada')), member('u2', profile('u2', 'Grace'))]);

        expect(profiles.getCachedByUserId('u1')?.userName).toBe('Ada');
        expect(profiles.getCachedByUserId('u2')?.userName).toBe('Grace');
    });

    /** A seeded profile is a cache hit, so the fire-and-forget resolver must not go to the wire. */
    it('makes resolveByUserId a no-op for a seeded member', () => {
        const {service, profiles, ctrl} = setup();

        service.getMembers('g1', 0, 100).subscribe();
        ctrl.expectOne(`${BASE}/guilds/g1/members?skip=0&take=100`)
            .flush([member('u1', profile('u1', 'Ada'))]);

        profiles.resolveByUserId('u1');

        // verify() in afterEach is the assertion: an unexpected GET would fail it.
        ctrl.expectNone(`${BASE.replace('/guild', '/social')}/profiles/by-user/u1`);
    });

    /** `profile` is optional on the row and absent rows must not take the rest of the list down. */
    it('skips members the server sent without a profile', () => {
        const {service, profiles, ctrl} = setup();

        service.getMembers('g1', 0, 100).subscribe();
        ctrl.expectOne(`${BASE}/guilds/g1/members?skip=0&take=100`)
            .flush([member('u1', undefined), member('u2', profile('u2', 'Grace'))]);

        expect(profiles.getCachedByUserId('u1')).toBeUndefined();
        expect(profiles.getCachedByUserId('u2')?.userName).toBe('Grace');
    });

    it('seeds from searchMembers too - same rows, same embedded profiles', () => {
        const {service, profiles, ctrl} = setup();

        service.searchMembers('g1', 'ad').subscribe();
        ctrl.expectOne(`${BASE}/guilds/g1/members/search?search=ad`)
            .flush([member('u1', profile('u1', 'Ada'))]);

        expect(profiles.getCachedByUserId('u1')?.userName).toBe('Ada');
    });

    /** The 404-to-empty path in searchMembers must not trip over an absent body. */
    it('survives a search that 404s', () => {
        const {service, ctrl} = setup();
        let result: GuildMemberDto[] | undefined;

        service.searchMembers('g1', 'nobody').subscribe(r => result = r);
        ctrl.expectOne(`${BASE}/guilds/g1/members/search?search=nobody`)
            .flush(null, {status: 404, statusText: 'Not Found'});

        expect(result).toEqual([]);
    });
});
