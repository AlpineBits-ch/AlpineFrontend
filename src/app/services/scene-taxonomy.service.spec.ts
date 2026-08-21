import {TestBed} from '@angular/core/testing';
import {Subject} from 'rxjs';
import {describe, expect, it} from 'vitest';

import {SceneTaxonomyService} from './scene-taxonomy.service';
import {RoleplayApi} from './roleplay-api.service';
import {RealtimeConnectionService} from './realtime-connection.service';
import {FakeRealtimeConnection} from '../testing/fake-realtime-connection';
import {SceneFolderDto, SceneTagDto, SceneTaxonomyDto} from '../dtos/response/scene.dto';

function folder(
    id: string,
    name: string,
    position = 0,
    parentFolderId: string | null = null,
): SceneFolderDto {
    return {id, guildId: 'g1', name, position, parentFolderId};
}

function tag(id: string, name: string, position = 0): SceneTagDto {
    return {id, guildId: 'g1', name, color: '#000000', position, moderated: false};
}

function apiStub() {
    const reads: Subject<SceneTaxonomyDto>[] = [];
    const deletes: Subject<void>[] = [];
    return {
        reads,
        deletes,
        getTaxonomy: () => {
            const subject = new Subject<SceneTaxonomyDto>();
            reads.push(subject);
            return subject;
        },
        deleteFolder: () => {
            const subject = new Subject<void>();
            deletes.push(subject);
            return subject;
        },
    };
}

function setup(loaded: SceneTaxonomyDto | null = null) {
    const api = apiStub();
    const realtime = new FakeRealtimeConnection();
    TestBed.configureTestingModule({
        providers: [
            {provide: RoleplayApi, useValue: api},
            {provide: RealtimeConnectionService, useValue: realtime},
        ],
    });
    const service = TestBed.inject(SceneTaxonomyService);
    service.ensureGuild('g1');
    if (loaded) api.reads[0].next(loaded);
    return {service, api, realtime};
}

describe('SceneTaxonomyService', () => {
    it('reads a guild once', () => {
        const {service, api} = setup();

        service.ensureGuild('g1');

        expect(api.reads).toHaveLength(1);
    });

    it('orders both halves by position, then by name', () => {
        const {service} = setup({
            guildId: 'g1',
            folders: [folder('f2', 'Arc II', 1), folder('f1', 'Arc I', 0)],
            tags: [tag('t2', 'betrayal', 1), tag('t1', 'ashfall', 0)],
        });

        expect(service.folders('g1').map(f => f.id)).toEqual(['f1', 'f2']);
        expect(service.tags('g1').map(t => t.id)).toEqual(['t1', 't2']);
    });

    it('replaces the whole set on a taxonomy event rather than merging it', () => {
        const {service, realtime} = setup({
            guildId: 'g1',
            folders: [folder('f1', 'Arc I')],
            tags: [tag('t1', 'ashfall')],
        });

        realtime.emit('guild.SceneTaxonomyChanged', {
            guildId: 'g1',
            folders: [],
            tags: [tag('t2', 'betrayal')],
        });

        expect(service.folders('g1')).toEqual([]);
        expect(service.tags('g1').map(t => t.id)).toEqual(['t2']);
    });

    it("drops tags the guild no longer has when naming a scene's labels", () => {
        const {service} = setup({guildId: 'g1', folders: [], tags: [tag('t1', 'ashfall')]});

        expect(service.resolveTags('g1', ['t1', 'gone']).map(t => t.id)).toEqual(['t1']);
    });

    it('reparents children locally when a folder is deleted', () => {
        const {service, api} = setup({
            guildId: 'g1',
            folders: [folder('f1', 'Arc I'), folder('f2', 'Sidequests', 0, 'f1')],
            tags: [],
        });

        service.deleteFolder('g1', 'f1').subscribe();
        api.deletes[0].next();

        // The child survives at the root: a delete removes the shelf, never what is on it.
        expect(service.folders('g1').map(f => f.id)).toEqual(['f2']);
        expect(service.folders('g1')[0].parentFolderId).toBeNull();
    });

    it('answers empty for a guild nobody has read', () => {
        const {service} = setup();

        expect(service.folders('other')).toEqual([]);
        expect(service.tags(null)).toEqual([]);
        expect(service.tag('g1', null)).toBeNull();
    });
});
