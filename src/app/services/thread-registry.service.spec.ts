import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {Subject} from 'rxjs';

import {ThreadRegistryService} from './thread-registry.service';
import {ApiConfigService} from './api-config.service';
import {GuildWebsocketService} from './guild-websocket.service';
import {NavigationService} from '../features/main-page/navigation.service';
import {ChannelDto, ChannelType} from '../dtos/response/guild.dto';

const BASE = 'https://api.test.example';
const GUILD_BASE = `${BASE}/api/v1/guild`;

function channelFixture(overrides: Partial<ChannelDto> = {}): ChannelDto {
    return {
        id: 'chan_thread',
        createdAt: new Date('2026-08-19T00:00:00Z'),
        updatedAt: new Date('2026-08-19T00:00:00Z'),
        name: 'about that message',
        description: '',
        type: ChannelType.Thread,
        guildId: 'g1',
        isAgeRestricted: false,
        isPrivate: false,
        categoryId: undefined,
        permissions: [],
        position: 0,
        slowModeSeconds: 0,
        parentChannelId: 'chan_parent',
        ...overrides,
    };
}

function setup(guildChannels: ChannelDto[] = []) {
    TestBed.resetTestingModule();
    const nav = {
        workspace: () => ({type: 'server' as const, guild: {id: 'g1', channels: guildChannels}}),
    };
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
            {
                provide: GuildWebsocketService,
                useValue: {
                    threadCreatedObservable: new Subject<unknown>(),
                    threadUpdatedObservable: new Subject<unknown>(),
                    messageThreadAttachedObservable: new Subject<unknown>(),
                },
            },
            {provide: NavigationService, useValue: nav},
        ],
    });
    return {
        service: TestBed.inject(ThreadRegistryService),
        http: TestBed.inject(HttpTestingController),
    };
}

describe('ThreadRegistryService', () => {
    it('resolves a thread already in the guild payload without a request', () => {
        const {service, http} = setup([channelFixture()]);

        expect(service.thread('chan_thread')?.name).toBe('about that message');
        service.ensureThread('chan_thread');
        http.verify();
    });

    it('fetches a thread the payload does not carry, once', () => {
        const {service, http} = setup();

        service.ensureThread('chan_thread');
        service.ensureThread('chan_thread');

        http.expectOne(`${GUILD_BASE}/channels/chan_thread`).flush(channelFixture());
        expect(service.thread('chan_thread')?.name).toBe('about that message');
        http.verify();
    });

    it('leaves a thread unresolved when the fetch 404s, and does not retry', () => {
        const {service, http} = setup();

        service.ensureThread('gone');
        http.expectOne(`${GUILD_BASE}/channels/gone`).flush(null, {status: 404, statusText: 'Not Found'});

        expect(service.thread('gone')).toBeNull();
        service.ensureThread('gone');
        http.verify();
    });

    it('folds a 409 on create into the thread id the server names', () => {
        const {service, http} = setup();
        let threadId: string | null = null;

        service.createFromMessage('chan_parent', 'mesg_1', {name: 'about'}).subscribe(id => (threadId = id));

        http.expectOne(`${GUILD_BASE}/channels/chan_parent/messages/mesg_1/threads`).flush(
            {threadId: 'chan_existing'},
            {status: 409, statusText: 'Conflict'},
        );

        expect(threadId).toBe('chan_existing');
    });

    it('merges payload threads with fetched ones when listing a parent', () => {
        const {service, http} = setup([channelFixture({id: 'chan_a', name: 'a'})]);

        service.ensureParent('chan_parent');
        http.expectOne(`${GUILD_BASE}/channels/chan_parent/threads`).flush([
            channelFixture({id: 'chan_b', name: 'b'}),
        ]);

        expect(
            service
                .threadsFor('chan_parent')
                .map(t => t.id)
                .sort(),
        ).toEqual(['chan_a', 'chan_b']);
    });
});
