import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {afterEach, describe, expect, it} from 'vitest';
import {Subject} from 'rxjs';

import {OwnMemberRevisionService} from './own-member-revision.service';
import {GuildService} from './guild.service';
import {GuildWebsocketService} from './guild-websocket.service';
import {ApiConfigService} from './api-config.service';
import {ProfileService} from './profile.service';
import {SelfGuildMemberDto} from '../dtos/response/member.dto';

const BASE = 'https://api.test.example';
const ME = `${BASE}/api/v1/guild/guilds/g1/me`;

/** The events this service listens to, in the shape `GuildWebsocketService` publishes them. */
function fakeWs() {
    return {
        memberUpdatedObservable: new Subject<{guildId: string; userId: string; nickname: string | null}>(),
        memberKickedObservable: new Subject<{guildId: string; userId: string}>(),
        memberBannedObservable: new Subject<{guildId: string; userId: string}>(),
        memberLeftObservable: new Subject<{guildId: string; userId: string}>(),
        memberMovedOutObservable: new Subject<{guildId: string; userId: string}>(),
        memberJoinedObservable: new Subject<{guildId: string; userId: string}>(),
    };
}

function setup() {
    const ws = fakeWs();
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
            {provide: GuildWebsocketService, useValue: ws},
            // Only our own row moves a permission gate, so the service needs an own-profile to
            // compare the event's userId against.
            {provide: ProfileService, useValue: {ownProfile: () => ({userId: 'me'})}},
        ],
    });
    return {
        // Constructing it is what subscribes to the events.
        service: TestBed.inject(OwnMemberRevisionService),
        guilds: TestBed.inject(GuildService),
        ws,
        ctrl: TestBed.inject(HttpTestingController),
    };
}

function selfMember(permissions: string): SelfGuildMemberDto {
    return {id: 'mem_1', guildId: 'g1', userId: 'me', permissions, roleMembers: []} as unknown as SelfGuildMemberDto;
}

describe('OwnMemberRevisionService', () => {
    afterEach(() => {
        try {
            TestBed.inject(HttpTestingController).verify();
        } finally {
            TestBed.resetTestingModule();
        }
    });

    it('bumps the revision when our own roles change', () => {
        const {service, ws} = setup();
        expect(service.revision()).toBe(0);

        ws.memberUpdatedObservable.next({guildId: 'g1', userId: 'me', nickname: null});

        expect(service.revision()).toBe(1);
    });

    it('ignores somebody else changing - their promotion moves no gate of ours', () => {
        const {service, ws} = setup();

        ws.memberUpdatedObservable.next({guildId: 'g1', userId: 'someone-else', nickname: null});

        expect(service.revision()).toBe(0);
    });

    /**
     * The regression test that matters: the bump tells every host to re-read the row, and a cache
     * that survived the event would answer all of those re-reads with the row from before the
     * demotion - which is exactly the "manage controls stay on screen until relaunch" bug this
     * service was written to end.
     */
    it('invalidates the cached row, so the re-read the bump triggers gets the new permissions', () => {
        const {guilds, ws, ctrl} = setup();
        guilds.getOwnMember('g1').subscribe();
        ctrl.expectOne(ME).flush(selfMember('ManageGuild'));

        ws.memberUpdatedObservable.next({guildId: 'g1', userId: 'me', nickname: null});

        let row: SelfGuildMemberDto | undefined;
        guilds.getOwnMember('g1').subscribe(m => row = m);
        ctrl.expectOne(ME).flush(selfMember('ViewChannel'));
        expect(row?.permissions).toBe('ViewChannel');
    });

    it('leaves the cache alone when the member who changed is not us', () => {
        const {guilds, ws, ctrl} = setup();
        guilds.getOwnMember('g1').subscribe();
        ctrl.expectOne(ME).flush(selfMember('ManageGuild'));

        ws.memberUpdatedObservable.next({guildId: 'g1', userId: 'someone-else', nickname: null});

        guilds.getOwnMember('g1').subscribe();
        ctrl.expectNone(ME);
    });

    it('drops the cached row when we are removed, without asking every host to re-read a 404', () => {
        const {service, guilds, ws, ctrl} = setup();
        guilds.getOwnMember('g1').subscribe();
        ctrl.expectOne(ME).flush(selfMember('ManageGuild'));

        ws.memberKickedObservable.next({guildId: 'g1', userId: 'me'});

        expect(service.revision()).toBe(0);
        guilds.getOwnMember('g1').subscribe();
        ctrl.expectOne(ME).flush(selfMember('ViewChannel'));
    });

    it('drops the cached row when we rejoin, so the pre-removal roles cannot come back', () => {
        const {guilds, ws, ctrl} = setup();
        guilds.getOwnMember('g1').subscribe();
        ctrl.expectOne(ME).flush(selfMember('ManageGuild'));

        ws.memberJoinedObservable.next({guildId: 'g1', userId: 'me'});

        guilds.getOwnMember('g1').subscribe();
        ctrl.expectOne(ME).flush(selfMember('ViewChannel'));
    });

    it('leaves the cache alone when somebody else is removed', () => {
        const {guilds, ws, ctrl} = setup();
        guilds.getOwnMember('g1').subscribe();
        ctrl.expectOne(ME).flush(selfMember('ManageGuild'));

        ws.memberKickedObservable.next({guildId: 'g1', userId: 'someone-else'});

        guilds.getOwnMember('g1').subscribe();
        ctrl.expectNone(ME);
    });
});
