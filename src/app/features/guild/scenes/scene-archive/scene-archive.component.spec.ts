import {signal} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {of, Subject} from 'rxjs';
import {beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

import {SceneArchiveComponent} from './scene-archive.component';
import {RoleplayApi} from '../../../../services/roleplay-api.service';
import {SceneArchiveService} from '../../../../services/scene-archive.service';
import {SceneTaxonomyService} from '../../../../services/scene-taxonomy.service';
import {SceneService} from '../../../../services/scene.service';
import {GuildService} from '../../../../services/guild.service';
import {ToastService} from '../../../../services/toast.service';
import {MainView, NavigationService} from '../../../main-page/navigation.service';
import {SceneDto, SceneFolderDto, SceneListDto, SceneStatus} from '../../../../dtos/response/scene.dto';
import {SceneListParams} from '../../../../dtos/request/scene.dto';
import {RealtimeConnectionService} from '../../../../services/realtime-connection.service';
import {FakeRealtimeConnection} from '../../../../testing/fake-realtime-connection';

// This runner's `localStorage` global has no methods, so anything reading it would silently see
// nothing stored. Same Map-backed stand-in `scene-rail-state.service.spec.ts` uses.
const localStore = new Map<string, string>();

beforeAll(() => {
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k: string) => localStore.get(k) ?? null,
            setItem: (k: string, v: string) => void localStore.set(k, String(v)),
            removeItem: (k: string) => void localStore.delete(k),
            clear: () => localStore.clear(),
        },
    });
});

beforeEach(() => localStore.clear());

function folder(id: string, parentFolderId: string | null = null, position = 0): SceneFolderDto {
    return {id, guildId: 'g1', name: id.toUpperCase(), position, parentFolderId};
}

function setup(folders: SceneFolderDto[]) {
    const view = signal<MainView>({
        type: 'scenes',
        guildId: 'g1',
        mode: 'archive',
        folderId: null,
        sceneChannelId: null,
    });
    const responses: Record<string, Subject<SceneListDto>> = {};
    const calls: SceneListParams[] = [];
    const api = {
        listScenes: (_guildId: string, params?: SceneListParams) => {
            const key = params?.folderId ?? '*';
            calls.push(params ?? {});
            const subject = new Subject<SceneListDto>();
            responses[key] = subject;
            return subject;
        },
    };

    TestBed.configureTestingModule({
        imports: [SceneArchiveComponent],
        providers: [
            provideTranslateService(),
            {provide: RoleplayApi, useValue: api},
            // The archive service follows the scene events to keep its shelves honest.
            {provide: RealtimeConnectionService, useValue: new FakeRealtimeConnection()},
            {
                provide: SceneTaxonomyService,
                useValue: {
                    folders: () => folders,
                    folder: (_guildId: string, id: string) => folders.find(f => f.id === id) ?? null,
                    tags: () => [],
                    resolveTags: () => [],
                    ensureGuild: () => undefined,
                },
            },
            {
                provide: SceneService,
                useValue: {
                    ensureGuild: () => undefined,
                    scenes: () => [],
                    speakableIds: () => new Set<string>(),
                    update: () => of({} as SceneDto),
                },
            },
            {provide: GuildService, useValue: {guilds: () => []}},
            {provide: ToastService, useValue: {error: vi.fn(), httpError: vi.fn()}},
            {
                provide: NavigationService,
                useValue: {
                    mainView: view,
                    openSceneChannel: vi.fn(),
                    openSceneFolder: vi.fn((_g: string, folderId: string | null) =>
                        view.update(held => ({...held, folderId})),
                    ),
                },
            },
        ],
    });

    const fixture: ComponentFixture<SceneArchiveComponent> = TestBed.createComponent(SceneArchiveComponent);
    fixture.componentRef.setInput('guildId', 'g1');
    fixture.detectChanges();

    return {fixture, responses, calls, view};
}

function reach(component: SceneArchiveComponent): Record<string, (...args: never[]) => unknown> {
    return component as unknown as Record<string, (...args: never[]) => unknown>;
}

describe('SceneArchiveComponent filing', () => {
    it('invalidates both the old and the new shelf once a move settles', () => {
        const {fixture, responses, view} = setup([folder('a'), folder('b')]);
        view.update(held => ({...held, folderId: 'a'}));
        fixture.detectChanges();
        responses['a'].next({
            scenes: [{channelId: 'ch_0', name: 'Scene 0', status: SceneStatus.Active, folderId: 'a'}],
            truncated: false,
        });
        fixture.detectChanges();

        const invalidateSpy = vi.spyOn(TestBed.inject(SceneArchiveService), 'invalidateShelves');

        reach(fixture.componentInstance)['file']('ch_0' as never, 'b' as never);
        fixture.detectChanges();

        expect(invalidateSpy).toHaveBeenCalledWith('g1', 'a', 'b');
    });

    /** A shelf and that shelf selected unfiltered are one cache key, so invalidation can empty the
     *  list on screen. Two scenes on the shelf is what tells "re-read" apart from "wiped". */
    it('keeps the rest of the shelf on screen when a card is filed out of the one being browsed', () => {
        const {fixture, responses, calls, view} = setup([folder('a'), folder('b')]);
        view.update(held => ({...held, folderId: 'a'}));
        fixture.detectChanges();
        responses['a'].next({
            scenes: [
                {channelId: 'ch_0', name: 'Scene 0', status: SceneStatus.Active, folderId: 'a'},
                {channelId: 'ch_1', name: 'Scene 1', status: SceneStatus.Active, folderId: 'a'},
            ],
            truncated: false,
        });
        fixture.detectChanges();

        const archive = TestBed.inject(SceneArchiveService);
        expect(archive.scenes()).toHaveLength(2);

        const readsOfA = () => calls.filter(params => params.folderId === 'a').length;
        const before = readsOfA();

        reach(fixture.componentInstance)['file']('ch_0' as never, 'b' as never);

        expect(readsOfA()).toBe(before + 1);
        responses['a'].next({
            scenes: [{channelId: 'ch_1', name: 'Scene 1', status: SceneStatus.Active, folderId: 'a'}],
            truncated: false,
        });
        fixture.detectChanges();

        expect(archive.scenes().map(s => s.channelId)).toEqual(['ch_1']);
    });
});
