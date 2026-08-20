import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {Subject} from 'rxjs';
import {describe, expect, it} from 'vitest';

import {SceneService} from './scene.service';
import {RoleplayApi} from './roleplay-api.service';
import {PersonaService} from './persona.service';
import {GuildWebsocketService} from './guild-websocket.service';
import {GuildService} from './guild.service';
import {NavigationService} from '../features/main-page/navigation.service';
import {SceneListDto, SceneListItemDto, SceneStatus} from '../dtos/response/scene.dto';
import {SceneListParams} from '../dtos/request/scene.dto';
import {GuildDto} from '../dtos/response/guild.dto';

function row(over: Partial<SceneListItemDto> = {}): SceneListItemDto {
    return {
        channelId: 'ch_1',
        name: 'The Long Road',
        status: SceneStatus.Active,
        currentTurnPersonaId: 'per_1',
        turnNumber: 3,
        postCount: 12,
        ...over,
    };
}

function apiStub() {
    const lists: Subject<SceneListDto>[] = [];
    const listCalls: (SceneListParams | undefined)[] = [];
    return {
        lists,
        listCalls,
        listScenes: (_guildId: string, params?: SceneListParams) => {
            listCalls.push(params);
            const subject = new Subject<SceneListDto>();
            lists.push(subject);
            return subject;
        },
    };
}

function wsStub() {
    return {
        sceneCreatedObservable: new Subject<any>(),
        sceneConcludedObservable: new Subject<any>(),
        sceneTurnChangedObservable: new Subject<any>(),
        sceneUpdatedObservable: new Subject<any>(),
        sceneTurnNudgeObservable: new Subject<any>(),
        sceneTagsChangedObservable: new Subject<any>(),
    };
}

/** The guild list as the board reads it: a scene is only openable once its channel is in here. */
function guildStub(channelIds: string[]) {
    const guilds = signal([{id: 'g1', channels: channelIds.map(id => ({id}))} as GuildDto]);
    const reads: Subject<GuildDto>[] = [];
    return {
        reads,
        guilds,
        getGuild: () => {
            const subject = new Subject<GuildDto>();
            reads.push(subject);
            return subject;
        },
        upsertGuild: (guild: GuildDto) => guilds.set([guild]),
    };
}

function setup(loaded: SceneListItemDto[] | null = [row()], channelIds = ['ch_1']) {
    const api = apiStub();
    const ws = wsStub();
    const guilds = guildStub(channelIds);
    TestBed.configureTestingModule({
        providers: [
            {provide: RoleplayApi, useValue: api},
            {provide: GuildWebsocketService, useValue: ws},
            {provide: PersonaService, useValue: {speakable: () => [], ensureCast: () => undefined}},
            {provide: GuildService, useValue: guilds},
            {provide: NavigationService, useValue: {updateCurrentGuild: () => undefined}},
        ],
    });
    const service = TestBed.inject(SceneService);
    if (loaded) {
        service.ensureGuild('g1');
        api.lists[0].next({scenes: loaded, truncated: false});
    }
    return {service, api, ws, guilds};
}

const CREATED = {
    guildId: 'g1',
    channelId: 'ch_2',
    parentChannelId: 'ch_parent',
    name: 'A Quiet Inn',
    oocThreadId: 'ch_ooc',
    status: SceneStatus.Open,
    participantPersonaIds: ['per_1', 'per_2'],
    turnOrder: ['per_1', 'per_2'],
    turnLengthHours: 48,
};

describe('SceneService board read', () => {
    it('asks for concluded and archived scenes, which the server excludes by default', () => {
        const {api} = setup();

        expect(api.listCalls[0]).toEqual({includeConcluded: true, includeArchived: true});
    });
});

describe('SceneService scene lifecycle events', () => {
    it('puts a created scene on a board that has been read', () => {
        const {service, ws} = setup();

        ws.sceneCreatedObservable.next(CREATED);

        const added = service.scenes('g1').find(s => s.channelId === 'ch_2');
        expect(added?.name).toBe('A Quiet Inn');
        expect(added?.status).toBe(SceneStatus.Open);
        expect(added?.participantCount).toBe(2);
        expect(added?.oocThreadId).toBe('ch_ooc');
    });

    it('leaves a board nobody has read to its first read', () => {
        const {service, ws} = setup(null);

        ws.sceneCreatedObservable.next(CREATED);

        expect(service.scenes('g1')).toEqual([]);
    });

    it('does not add a scene the creating window already absorbed', () => {
        const {service, ws} = setup([row({channelId: 'ch_2'})]);

        ws.sceneCreatedObservable.next(CREATED);

        expect(service.scenes('g1').length).toBe(1);
    });

    it('reads the guild again for a scene channel it does not have', () => {
        const {ws, guilds} = setup();

        ws.sceneCreatedObservable.next(CREATED);

        expect(guilds.reads.length).toBe(1);
        guilds.reads[0].next({id: 'g1', channels: [{id: 'ch_1'}, {id: 'ch_2'}]} as GuildDto);
        expect(guilds.guilds()[0].channels.some(c => c.id === 'ch_2')).toBe(true);
    });

    it('does not read the guild for a scene channel it already has', () => {
        const {ws, guilds} = setup([row()], ['ch_1', 'ch_2']);

        ws.sceneCreatedObservable.next(CREATED);

        expect(guilds.reads).toEqual([]);
    });

    it('concludes the row and stops nudging on it', () => {
        const {service, ws} = setup();

        ws.sceneTurnNudgeObservable.next({
            guildId: 'g1',
            channelId: 'ch_1',
            personaId: 'per_1',
            nudgeCount: 2,
        });
        expect(service.nudge('ch_1')).not.toBeNull();

        ws.sceneConcludedObservable.next({
            guildId: 'g1',
            channelId: 'ch_1',
            status: SceneStatus.Concluded,
            conclusionNote: 'They made it to the coast.',
            turnNumber: 41,
            postCount: 96,
            concludedAt: '2026-08-18T10:00:00Z',
        });

        const concluded = service.scenes('g1')[0];
        expect(concluded.status).toBe(SceneStatus.Concluded);
        expect(concluded.turnNumber).toBe(41);
        expect(concluded.postCount).toBe(96);
        expect(service.nudge('ch_1')).toBeNull();
        expect(service.waitingOnMe('g1')).toEqual([]);
    });
});
