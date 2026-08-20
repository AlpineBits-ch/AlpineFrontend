import {TestBed} from '@angular/core/testing';
import {Subject} from 'rxjs';
import {describe, expect, it} from 'vitest';

import {archiveKey, SceneArchiveService} from './scene-archive.service';
import {RoleplayApi} from './roleplay-api.service';
import {SceneListDto, SceneListItemDto, SceneStatus} from '../dtos/response/scene.dto';
import {SceneListParams} from '../dtos/request/scene.dto';

function row(over: Partial<SceneListItemDto> = {}): SceneListItemDto {
    return {
        channelId: 'ch_1',
        name: 'The Siege of Blackwater',
        status: SceneStatus.Concluded,
        ...over,
    };
}

function page(count: number, over: Partial<SceneListItemDto> = {}): SceneListDto {
    return {
        scenes: Array.from({length: count}, (_, i) => row({channelId: `ch_${i}`, ...over})),
        truncated: false,
    };
}

function setup() {
    const calls: SceneListParams[] = [];
    const responses: Subject<SceneListDto>[] = [];
    const api = {
        listScenes: (_guildId: string, params?: SceneListParams) => {
            calls.push(params ?? {});
            const subject = new Subject<SceneListDto>();
            responses.push(subject);
            return subject;
        },
    };
    TestBed.configureTestingModule({providers: [{provide: RoleplayApi, useValue: api}]});
    return {service: TestBed.inject(SceneArchiveService), calls, responses};
}

const BASE = {guildId: 'g1', folderId: null, tagIds: [] as string[], q: ''};

describe('SceneArchiveService', () => {
    it('asks for every scene by default, newest first', () => {
        const {service, calls} = setup();

        service.apply(BASE);

        expect(calls[0]).toMatchObject({
            includeConcluded: true,
            includeArchived: true,
            sort: 'ended',
            offset: 0,
        });
        expect(calls[0].archivedOnly).toBeUndefined();
    });

    it('ANDs the selected tags into one request', () => {
        const {service, calls} = setup();

        service.apply({...BASE, tagIds: ['t1', 't2']});

        expect(calls[0].tagIds).toEqual(['t1', 't2']);
    });

    it('leaves an empty filter off the wire so the server default applies', () => {
        const {service, calls} = setup();

        service.apply(BASE);

        expect(calls[0].tagIds).toBeUndefined();
        expect(calls[0].q).toBeUndefined();
        expect(calls[0].folderId).toBeUndefined();
    });

    it('does not re-read a filter it already holds', () => {
        const {service, calls, responses} = setup();
        service.apply(BASE);
        responses[0].next(page(2));

        service.apply({...BASE});

        expect(calls).toHaveLength(1);
    });

    it('reads again when the filter changes, and holds each answer separately', () => {
        const {service, calls, responses} = setup();
        service.apply(BASE);
        responses[0].next(page(2));

        service.apply({...BASE, folderId: 'f1'});
        responses[1].next(page(1));

        expect(calls).toHaveLength(2);
        expect(service.scenes()).toHaveLength(1);

        // Going back is answered from what is already held.
        service.apply(BASE);
        expect(calls).toHaveLength(2);
        expect(service.scenes()).toHaveLength(2);
    });

    it('appends the next page rather than replacing the first', () => {
        const {service, responses, calls} = setup();
        service.apply(BASE);
        responses[0].next(page(50));

        service.more();
        responses[1].next({scenes: [row({channelId: 'ch_extra'})], truncated: false});

        expect(calls[1].offset).toBe(50);
        expect(service.scenes()).toHaveLength(51);
    });

    it('stops offering more once a short page comes back', () => {
        const {service, responses} = setup();
        service.apply(BASE);

        responses[0].next(page(3));

        expect(service.hasMore()).toBe(false);
    });

    it('renders an error rather than a permanent skeleton when the first read fails', () => {
        const {service, responses} = setup();
        service.apply(BASE);

        responses[0].error(new Error('nope'));

        expect(service.errored()).toBe(true);
        expect(service.loading()).toBe(false);
        expect(service.unread()).toBe(false);
    });

    it('patches a row in place so filing needs no refetch', () => {
        const {service, responses} = setup();
        service.apply(BASE);
        responses[0].next(page(2));

        service.patch('ch_0', {folderId: 'f9'});

        expect(service.scenes().find(s => s.channelId === 'ch_0')?.folderId).toBe('f9');
    });

    it('drops a row that no longer belongs to the shelf being shown', () => {
        const {service, responses} = setup();
        service.apply(BASE);
        responses[0].next(page(2));

        service.drop('ch_0');

        expect(service.scenes().map(s => s.channelId)).toEqual(['ch_1']);
    });

    it('asks only for finished scenes when the filter says so', () => {
        const {service, calls} = setup();

        service.apply({...BASE, status: 'finished'});

        expect(calls[0]).toMatchObject({archivedOnly: true, includeConcluded: true, includeArchived: true});
    });

    it('asks for the live board alone when the filter says running', () => {
        const {service, calls} = setup();

        service.apply({...BASE, status: 'running'});

        expect(calls[0].archivedOnly).toBeUndefined();
        expect(calls[0].includeConcluded).toBeUndefined();
        expect(calls[0].includeArchived).toBeUndefined();
    });

    it('caches each status apart', () => {
        expect(archiveKey({...BASE, status: 'running'})).not.toBe(archiveKey({...BASE, status: 'finished'}));
    });

    it('treats an absent status as all', () => {
        expect(archiveKey(BASE)).toBe(archiveKey({...BASE, status: 'all'}));
    });

    it('reads a shelf without moving the selection', () => {
        const {service, calls, responses} = setup();

        service.apply(BASE);
        service.peek('g1', 'f1');
        responses[1].next(page(2, {folderId: 'f1'}));

        expect(calls[1]).toMatchObject({folderId: 'f1'});
        expect(service.peeked('g1', 'f1')).toHaveLength(2);
        // The selection is still every shelf, not the one that was peeked.
        expect(service.current()?.folderId).toBeNull();
    });

    it('does not re-read a shelf it already holds', () => {
        const {service, calls, responses} = setup();

        service.peek('g1', 'f1');
        responses[0].next(page(1, {folderId: 'f1'}));
        service.peek('g1', 'f1');

        expect(calls).toHaveLength(1);
    });

    it('shares one request between a peeked shelf and the same shelf selected', () => {
        const {service, calls, responses} = setup();

        service.peek('g1', 'f1');
        responses[0].next(page(3, {folderId: 'f1'}));
        service.apply({...BASE, folderId: 'f1'});

        expect(calls).toHaveLength(1);
        expect(service.scenes()).toHaveLength(3);
    });
});

describe('archiveKey', () => {
    it('does not care what order the tags arrived in', () => {
        expect(archiveKey({...BASE, tagIds: ['b', 'a']})).toBe(archiveKey({...BASE, tagIds: ['a', 'b']}));
    });

    it('tells a folder apart from no folder', () => {
        expect(archiveKey({...BASE, folderId: 'f1'})).not.toBe(archiveKey(BASE));
    });
});
