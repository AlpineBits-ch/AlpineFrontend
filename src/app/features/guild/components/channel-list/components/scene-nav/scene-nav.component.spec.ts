import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal} from '@angular/core';
import {provideTranslateService} from '@ngx-translate/core';
import {of, Subject} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {SceneNavComponent} from './scene-nav.component';
import {SceneService} from '../../../../../../services/scene.service';
import {SceneTaxonomyService} from '../../../../../../services/scene-taxonomy.service';
import {GuildService} from '../../../../../../services/guild.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {ToastService} from '../../../../../../services/toast.service';
import {MainView, NavigationService} from '../../../../../main-page/navigation.service';
import {SceneFolderDto, SceneListItemDto, SceneStatus} from '../../../../../../dtos/response/scene.dto';
import {installMemoryStorage} from '../../../../../../testing/memory-storage';
import {RoleplayApi} from '../../../../../../services/roleplay-api.service';
import {SceneRailStateService} from '../../../../../../services/scene-rail-state.service';
import {SceneListDto} from '../../../../../../dtos/response/scene.dto';
import {SceneListParams} from '../../../../../../dtos/request/scene.dto';

function scene(over: Partial<SceneListItemDto> = {}): SceneListItemDto {
    return {channelId: 'ch_1', name: 'Scene', status: SceneStatus.Active, ...over};
}

function folder(id: string, name: string, position = 0): SceneFolderDto {
    return {id, guildId: 'g1', name, position, parentFolderId: null};
}

const SCENES = [
    scene({channelId: 'mine', name: 'The Ford at Dawn', folderId: 'a', currentTurnPersonaId: 'p1'}),
    scene({channelId: 'other', name: 'Nightwatch', folderId: 'a'}),
    scene({channelId: 'done', name: 'The Last Muster', folderId: 'a', status: SceneStatus.Concluded}),
];

const FOLDERS = [folder('a', 'Act I', 0), folder('b', 'Act II', 1)];

interface Options {
    features?: string;
    scenes?: SceneListItemDto[];
    folders?: SceneFolderDto[];
}

function setup(options: Options = {}) {
    const view = signal<MainView>({
        type: 'scenes',
        guildId: 'g1',
        mode: 'playing',
        folderId: null,
        sceneChannelId: null,
    });
    const nav = {
        mainView: view,
        openScenes: vi.fn(),
        openSceneFolder: vi.fn(),
        openSceneChannel: vi.fn(),
    };
    const channels = (options.scenes ?? SCENES).map(row => ({id: row.channelId, type: 0}));
    const shelves: Record<string, Subject<SceneListDto>> = {};
    const calls: SceneListParams[] = [];
    const api = {
        listScenes: (_guildId: string, params?: SceneListParams) => {
            calls.push(params ?? {});
            const subject = new Subject<SceneListDto>();
            shelves[params?.folderId ?? '*'] = subject;
            return subject;
        },
    };

    TestBed.configureTestingModule({
        imports: [SceneNavComponent],
        providers: [
            provideTranslateService(),
            {provide: RoleplayApi, useValue: api},
            {
                provide: SceneService,
                useValue: {
                    scenes: () => options.scenes ?? SCENES,
                    sceneForOoc: (_g: string, threadId: string) =>
                        (options.scenes ?? SCENES).find(row => row.oocThreadId === threadId) ?? null,
                    speakableIds: () => new Set(['p1']),
                    ensureGuild: () => undefined,
                    update: () => of(undefined),
                },
            },
            {
                provide: SceneTaxonomyService,
                useValue: {
                    folders: () => options.folders ?? FOLDERS,
                    ensureGuild: () => undefined,
                    reorderFolders: () => of(undefined),
                },
            },
            {
                provide: GuildService,
                useValue: {
                    guilds: () => [
                        {id: 'g1', ownerId: 'u1', channels, features: options.features ?? 'Scenes'},
                    ],
                    getOwnMember: () => of(null),
                },
            },
            {provide: ProfileService, useValue: {ownProfile: () => ({userId: 'u1'})}},
            {
                provide: ToastService,
                useValue: {error: vi.fn(), httpError: vi.fn(), success: vi.fn(), warn: vi.fn()},
            },
            {provide: NavigationService, useValue: nav},
        ],
    });

    const fixture: ComponentFixture<SceneNavComponent> = TestBed.createComponent(SceneNavComponent);
    fixture.componentRef.setInput('guildId', 'g1');
    fixture.detectChanges();

    return {fixture, nav, view, shelves, calls};
}

function reach(fixture: ComponentFixture<SceneNavComponent>): Record<string, () => unknown> {
    return fixture.componentInstance as unknown as Record<string, () => unknown>;
}

function openSection(fixture: ComponentFixture<SceneNavComponent>): void {
    (fixture.nativeElement.querySelector('.chan-section-toggle') as HTMLElement).click();
    fixture.detectChanges();
}

function expandShelf(fixture: ComponentFixture<SceneNavComponent>, folderId: string): void {
    TestBed.inject(SceneRailStateService).toggle('g1', folderId);
    fixture.detectChanges();
}

describe('SceneNavComponent', () => {
    let restoreStorage: () => void;

    beforeEach(() => {
        restoreStorage = installMemoryStorage();
    });

    afterEach(() => restoreStorage());

    it('draws nothing at all for a guild without the scenes module', () => {
        const {fixture} = setup({features: 'Wiki'});

        expect(fixture.nativeElement.querySelector('.chan-section')).toBeNull();
    });

    it('draws the header closed, with no tree under it, on a first visit', () => {
        const {fixture} = setup();

        expect(fixture.nativeElement.querySelector('.chan-section')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('app-scene-folder-rail')).toBeNull();
    });

    it('opens the tree when the header is pressed', () => {
        const {fixture} = setup();

        openSection(fixture);

        expect(fixture.nativeElement.querySelector('app-scene-folder-rail')).not.toBeNull();
        expect(fixture.nativeElement.textContent).toContain('Act I');
    });

    it('remembers an opened section, so a restart draws it open', () => {
        const {fixture} = setup();
        openSection(fixture);

        const second = TestBed.createComponent(SceneNavComponent);
        second.componentRef.setInput('guildId', 'g1');
        second.detectChanges();

        expect(second.nativeElement.querySelector('app-scene-folder-rail')).not.toBeNull();
    });

    it('puts a scene waiting on you above one that moved more recently', () => {
        const {fixture} = setup({
            scenes: [
                scene({channelId: 'newer', name: 'Nightwatch', updatedAt: '2026-08-20T10:00:00Z'}),
                scene({
                    channelId: 'yours',
                    name: 'The Ford at Dawn',
                    currentTurnPersonaId: 'p1',
                    updatedAt: '2026-08-01T10:00:00Z',
                }),
            ],
        });

        const recent = reach(fixture)['recent']() as {channelId: string}[];
        expect(recent.map(leaf => leaf.channelId)).toEqual(['yours', 'newer']);
    });

    it('keeps a folder in the tree when everything in it has finished', () => {
        const {fixture} = setup({
            scenes: [scene({channelId: 'done', name: 'The Last Muster', status: SceneStatus.Concluded})],
        });
        openSection(fixture);

        expect(fixture.nativeElement.textContent).toContain('Act I');
        expect(fixture.nativeElement.textContent).toContain('Act II');
    });

    it('reads a shelf only once it is opened, and asks for the finished scenes on it', () => {
        const {fixture, shelves, calls} = setup();
        openSection(fixture);
        expect(shelves['a']).toBeUndefined();

        expandShelf(fixture, 'a');
        expect(calls.find(params => params.folderId === 'a')?.includeConcluded).toBe(true);
        shelves['a'].next({
            scenes: [
                scene({
                    channelId: 'done',
                    name: 'The Last Muster',
                    folderId: 'a',
                    status: SceneStatus.Concluded,
                }),
            ],
            truncated: false,
        });
        fixture.detectChanges();

        expect(fixture.nativeElement.textContent).toContain('The Last Muster');
    });

    it('counts an opened shelf from what it read, and never guesses at a closed one', () => {
        const {fixture, shelves} = setup();
        openSection(fixture);
        expandShelf(fixture, 'a');
        shelves['a'].next({
            scenes: [
                scene({channelId: 'done', folderId: 'a', status: SceneStatus.Concluded}),
                scene({channelId: 'other', folderId: 'a'}),
            ],
            truncated: false,
        });
        fixture.detectChanges();

        const tree = reach(fixture)['tree']() as {folder: {id: string}; count: number}[];
        expect(tree.find(node => node.folder.id === 'a')?.count).toBe(2);
        expect(tree.find(node => node.folder.id === 'b')?.count).toBe(0);
    });

    it('keeps the scene marked while its out-of-character side is the one hosted', () => {
        const {fixture, view} = setup({
            scenes: [scene({channelId: 'mine', name: 'The Ford at Dawn', oocThreadId: 'mine-ooc'})],
        });
        view.update(held => ({...held, sceneChannelId: 'mine-ooc'}));
        fixture.detectChanges();

        expect(reach(fixture)['activeChannelId']()).toBe('mine');
    });

    it('filters the scenes view to the shelf that was chosen', () => {
        const {fixture, nav} = setup();
        openSection(fixture);

        (fixture.nativeElement.querySelector('.rail-pick') as HTMLElement).click();

        expect(nav.openSceneFolder).toHaveBeenCalledWith('g1', 'a');
    });

    it('opens a scene chosen from the recent block', () => {
        const {fixture, nav} = setup();
        openSection(fixture);

        (fixture.nativeElement.querySelector('.rail-leaf') as HTMLElement).click();

        expect(nav.openSceneChannel).toHaveBeenCalledWith('g1', 'mine', false);
    });
});
