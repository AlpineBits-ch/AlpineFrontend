import {TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection, signal} from '@angular/core';
import {UserActivityService} from './user-activity.service';
import {ProfileService} from './profile.service';
import {Activity} from '../models/activity.model';
import {GuildMemberDto} from '../dtos/response/member.dto';

const ownProfile = signal<{ userId: string } | undefined>(undefined);

/**
 * Only `ownProfile` is used, and standing in for it avoids dragging `ApiConfigService` and the
 * whole OAuth chain into a test about a keyed map.
 */
function setup(): UserActivityService {
    ownProfile.set({userId: 'usr_self'});
    TestBed.configureTestingModule({
        providers: [
            provideZonelessChangeDetection(),
            {provide: ProfileService, useValue: {ownProfile}},
        ],
    });
    const service = TestBed.inject(UserActivityService);
    // Flushes the sign-out effect's first run while a user is still present. Without it the
    // signed-in and signed-out states coalesce into a single run that sees no change at all, and
    // the sign-out test passes or fails on scheduling rather than on behaviour.
    TestBed.tick();
    return service;
}

function game(name = 'Overwatch'): Activity {
    return {type: 'Playing', name, source: 'ProcessScan'};
}

function member(userId: string, activities?: Activity[]): GuildMemberDto {
    return {userId, activities} as GuildMemberDto;
}

describe('UserActivityService', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('reports nothing for a user it has never heard of', () => {
        const service = setup();

        expect(service.activitiesFor('usr_1')).toEqual([]);
        expect(service.primaryFor('usr_1')).toBeNull();
        expect(service.activitiesFor(undefined)).toEqual([]);
    });

    it('keeps activities per user', () => {
        const service = setup();
        service.set('usr_1', [game('Overwatch')]);
        service.set('usr_2', [game('Deep Rock Galactic')]);

        expect(service.primaryFor('usr_1')?.name).toBe('Overwatch');
        expect(service.primaryFor('usr_2')?.name).toBe('Deep Rock Galactic');
    });

    /**
     * `guild.PresenceChanged` carries the complete post-change list, so an empty one is the only
     * way the server can say a game ended. Merging would make that unrepresentable.
     */
    it('replaces rather than merges, so a stopped game disappears', () => {
        const service = setup();
        service.set('usr_1', [game('Overwatch')]);

        service.set('usr_1', []);

        expect(service.activitiesFor('usr_1')).toEqual([]);
    });

    it('caps the list at the three the server allows', () => {
        const service = setup();

        service.set('usr_1', [game('a'), game('b'), game('c'), game('d')]);

        expect(service.activitiesFor('usr_1')).toHaveLength(3);
    });

    it('treats a null list as nothing rather than throwing', () => {
        const service = setup();

        expect(() => service.set('usr_1', null)).not.toThrow();
        expect(service.activitiesFor('usr_1')).toEqual([]);
    });

    it('exposes the signed-in user own activities', () => {
        const service = setup();
        service.set('usr_self', [game('Factorio')]);

        expect(service.own().map(a => a.name)).toEqual(['Factorio']);
    });

    it('seeds a page of members', () => {
        const service = setup();

        service.seedFromMembers([member('usr_1', [game('Overwatch')]), member('usr_2', [])]);

        expect(service.primaryFor('usr_1')?.name).toBe('Overwatch');
        expect(service.activitiesFor('usr_2')).toEqual([]);
    });

    /**
     * `activities` is optional until the backend ships it. Reading "the server did not say" as
     * "nothing is playing" would have every roster fetch wipe presence that arrived over the socket
     * a moment earlier.
     */
    it('leaves a member alone when the payload omits activities entirely', () => {
        const service = setup();
        service.set('usr_1', [game('Overwatch')]);

        service.seedFromMembers([member('usr_1')]);

        expect(service.primaryFor('usr_1')?.name).toBe('Overwatch');
    });

    it('forgets everything on sign-out, so the next account does not inherit a roster', () => {
        const service = setup();
        service.set('usr_1', [game('Overwatch')]);

        ownProfile.set(undefined);
        TestBed.tick();

        expect(service.activitiesFor('usr_1')).toEqual([]);
    });
});
