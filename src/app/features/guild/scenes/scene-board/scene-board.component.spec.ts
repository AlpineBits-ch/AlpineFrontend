import {ChangeDetectionStrategy, Component, input, signal} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {of} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {SceneBoardComponent, SceneGroup} from './scene-board.component';
import {SceneService} from '../../../../services/scene.service';
import {SceneTaxonomyService} from '../../../../services/scene-taxonomy.service';
import {PersonaService} from '../../../../services/persona.service';
import {GuildService} from '../../../../services/guild.service';
import {ProfileService} from '../../../../services/profile.service';
import {ToastService} from '../../../../services/toast.service';
import {MainView, NavigationService} from '../../../main-page/navigation.service';
import {SceneFolderDto, SceneListItemDto, SceneStatus} from '../../../../dtos/response/scene.dto';
import {ChannelDto, ChannelType} from '../../../../dtos/response/guild.dto';
import {installMemoryStorage} from '../../../../testing/memory-storage';
import {ChannelComponent} from '../../components/channel/channel.component';

/**
 * The real one drags the whole message stack into a board test. Only its title slot is kept, which
 * is the half of the contract the shell depends on.
 */
@Component({
    selector: 'app-channel',
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: '<header><ng-content select="[channelTitle]" /></header>',
})
class StubChannelComponent {
    readonly channel = input<unknown>();
}

function scene(over: Partial<SceneListItemDto> = {}): SceneListItemDto {
    return {channelId: 'ch_1', name: 'Scene', status: SceneStatus.Active, ...over};
}

function folder(
    id: string,
    name: string,
    position = 0,
    parentFolderId: string | null = null,
): SceneFolderDto {
    return {id, guildId: 'g1', name, position, parentFolderId};
}

const SCENES = [
    scene({channelId: 'mine', name: 'The Ford at Dawn', folderId: 'a', currentTurnPersonaId: 'p1'}),
    scene({channelId: 'other', name: 'Nightwatch', folderId: 'a'}),
    scene({channelId: 'second', name: 'The Burning Gate', folderId: 'b'}),
    scene({channelId: 'loose', name: 'Council of Crows'}),
    scene({channelId: 'done', name: 'The Last Muster', folderId: 'a', status: SceneStatus.Concluded}),
];

const FOLDERS = [folder('a', 'Act I', 0), folder('b', 'Act II', 1)];

function chan(id: string, type: ChannelType = ChannelType.Scene): ChannelDto {
    return {id, type, guildId: 'g1', name: id} as unknown as ChannelDto;
}

function setup(scenes = SCENES, folders = FOLDERS, channels: ChannelDto[] = []) {
    const view = signal<MainView>({
        type: 'scenes',
        guildId: 'g1',
        mode: 'playing',
        folderId: null,
        sceneChannelId: null,
    });

    TestBed.configureTestingModule({
        imports: [SceneBoardComponent],
        providers: [
            provideTranslateService(),
            {
                provide: SceneService,
                useValue: {
                    scenes: () => scenes,
                    scene: () => null,
                    sceneForOoc: (_g: string, threadId: string) =>
                        scenes.find(row => row.oocThreadId === threadId) ?? null,
                    speakableIds: () => new Set(['p1']),
                    now: () => 0,
                    isLoading: () => false,
                    ensureGuild: () => undefined,
                },
            },
            {
                provide: SceneTaxonomyService,
                useValue: {
                    folders: () => folders,
                    folder: () => null,
                    ensureGuild: () => undefined,
                },
            },
            {provide: PersonaService, useValue: {identity: () => null}},
            {
                provide: GuildService,
                useValue: {guilds: () => [{id: 'g1', channels}], getOwnMember: () => of(null)},
            },
            {provide: ProfileService, useValue: {ownProfile: () => ({userId: 'u1'})}},
            {
                provide: ToastService,
                useValue: {error: vi.fn(), httpError: vi.fn(), success: vi.fn(), warn: vi.fn()},
            },
            {
                provide: NavigationService,
                useValue: {
                    mainView: view,
                    openChannel: vi.fn(),
                    openChannelFromStart: vi.fn(),
                    openScenes: vi.fn(),
                    openSceneFolder: vi.fn((_g: string, folderId: string | null) =>
                        view.update(held => ({...held, folderId, sceneChannelId: null})),
                    ),
                    openSceneChannel: vi.fn((_g: string, channelId: string) =>
                        view.update(held => ({...held, sceneChannelId: channelId})),
                    ),
                    closeSceneChannel: vi.fn(),
                },
            },
        ],
    });

    TestBed.overrideComponent(SceneBoardComponent, {
        remove: {imports: [ChannelComponent]},
        add: {imports: [StubChannelComponent]},
    });

    const fixture: ComponentFixture<SceneBoardComponent> = TestBed.createComponent(SceneBoardComponent);
    fixture.componentRef.setInput('guildId', 'g1');
    fixture.detectChanges();
    return {
        fixture,
        view,
        component: fixture.componentInstance as unknown as {
            groups: () => SceneGroup[];
            tree: () => {folder: {id: string}; count: number}[];
            sceneChannel: () => {id: string} | null;
            pick: (folderId: string | null) => void;
        },
    };
}

describe('SceneBoardComponent grouping', () => {
    let restoreStorage: () => void;

    beforeEach(() => {
        restoreStorage = installMemoryStorage();
    });

    afterEach(() => restoreStorage());

    it('groups by status when the guild files nothing', () => {
        const {fixture, component} = setup(SCENES, []);
        fixture.detectChanges();

        expect(component.groups().map(g => g.key)).toEqual(['yours', 'running']);
    });

    it('groups by folder whenever the guild has folders', () => {
        const {fixture, component} = setup();
        fixture.detectChanges();

        const keys = component.groups().map(g => g.key);
        expect(keys[0]).toBe('yours');
        expect(keys).toContain('folder:a');
        expect(keys).toContain('folder:b');
        expect(keys.at(-1)).toBe('unfiled');
    });

    it('does not repeat a pinned scene inside its folder section', () => {
        const {fixture, component} = setup();
        fixture.detectChanges();

        const actOne = component.groups().find(g => g.key === 'folder:a');
        expect(actOne?.rows.map(r => r.scene.channelId)).toEqual(['other']);
    });

    it('names the folder a pinned scene came from', () => {
        const {fixture, component} = setup();
        fixture.detectChanges();

        const yours = component.groups().find(g => g.key === 'yours');
        expect(yours?.rows[0].folderPath).toBe('Act I');
    });

    it('names the whole path, not just the leaf folder, on a pinned row', () => {
        const {fixture, component} = setup(
            [scene({channelId: 'deep', name: 'The Long Road', folderId: 'a1', currentTurnPersonaId: 'p1'})],
            [...FOLDERS, folder('a1', 'Greyford', 0, 'a')],
        );
        fixture.detectChanges();

        const yours = component.groups().find(g => g.key === 'yours');
        expect(yours?.rows[0].folderPath).toBe('Act I / Greyford');
    });

    it('shows only the chosen folder when one is selected', () => {
        const {fixture, component} = setup();
        component.pick('b');
        fixture.detectChanges();

        const keys = component.groups().map(g => g.key);
        expect(keys).toEqual(['folder:b']);
    });

    it('keeps a scene waiting on you visible when its own folder is selected', () => {
        const {fixture, component} = setup();
        component.pick('a');
        fixture.detectChanges();

        const rows = component.groups().flatMap(g => g.rows.map(r => r.scene.channelId));
        expect(rows).toContain('mine');
    });

    it('shows only the unfiled scene when the unfiled bucket is selected', () => {
        const {fixture, component} = setup();
        component.pick('unfiled');
        fixture.detectChanges();

        const groups = component.groups();
        expect(groups.some(g => g.key.startsWith('folder:'))).toBe(false);
        expect(groups.flatMap(g => g.rows.map(r => r.scene.channelId))).toEqual(['loose']);
    });
});

describe('SceneBoardComponent opening a row', () => {
    let restoreStorage: () => void;

    beforeEach(() => {
        restoreStorage = installMemoryStorage();
    });

    afterEach(() => restoreStorage());

    it('raises a message for a channel that is not in the guild', () => {
        const {fixture} = setup();
        const toast = TestBed.inject(ToastService) as unknown as {error: ReturnType<typeof vi.fn>};

        (fixture.componentInstance as unknown as {open: (row: {scene: {channelId: string}}) => void}).open({
            scene: {channelId: 'gone'},
        });

        expect(toast.error).toHaveBeenCalledWith('SCENE.ARCHIVE.OPEN_ERROR', {
            detail: 'SCENE.ARCHIVE.OPEN_ERROR_DETAIL',
        });
    });
});

describe('SceneBoardComponent shell', () => {
    let restoreStorage: () => void;

    beforeEach(() => {
        restoreStorage = installMemoryStorage();
    });

    afterEach(() => restoreStorage());

    it('draws its own header and grouping while no scene is open, and no folder panel', () => {
        const {fixture, component} = setup();

        expect(component.sceneChannel()).toBeNull();
        expect(fixture.nativeElement.querySelector('app-scene-folder-panel')).toBeNull();
        expect(fixture.nativeElement.querySelector('header.app-header')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('app-scene-breadcrumb')).toBeNull();
        expect(fixture.nativeElement.querySelector('.board-row')).not.toBeNull();
    });

    it('hosts the scene in the shell once one is open', () => {
        const {fixture, view, component} = setup(SCENES, FOLDERS, [chan('mine')]);
        view.update(held => ({...held, sceneChannelId: 'mine'}));
        fixture.detectChanges();

        expect(component.sceneChannel()?.id).toBe('mine');
        expect(fixture.nativeElement.querySelector('app-scene-breadcrumb')).not.toBeNull();
        expect(fixture.nativeElement.querySelector('.board-row')).toBeNull();
    });

    /** Four bars stacked above the first post is what this replaced. */
    it('drops its own header while a scene is open, and hands the breadcrumb to the channel', () => {
        const {fixture, view} = setup(SCENES, FOLDERS, [chan('mine')]);
        view.update(held => ({...held, sceneChannelId: 'mine'}));
        fixture.detectChanges();

        expect(fixture.nativeElement.querySelector('header.app-header')).toBeNull();
        const projected = fixture.nativeElement.querySelector('[channelTitle] app-scene-breadcrumb');
        expect(projected).not.toBeNull();
    });

    it('falls back to the board for a channel whose type is not a message view', () => {
        const {fixture, view, component} = setup(SCENES, FOLDERS, [chan('mine', ChannelType.Voice)]);
        view.update(held => ({...held, sceneChannelId: 'mine'}));
        fixture.detectChanges();

        expect(component.sceneChannel()).toBeNull();
        expect(fixture.nativeElement.querySelector('.board-row')).not.toBeNull();
    });

    it('falls back to the board when the open scene names a channel that is gone', () => {
        const {fixture, view, component} = setup(SCENES, FOLDERS, [chan('mine')]);
        view.update(held => ({...held, sceneChannelId: 'vanished'}));
        fixture.detectChanges();

        expect(component.sceneChannel()).toBeNull();
        expect(fixture.nativeElement.querySelector('.board-row')).not.toBeNull();
    });
});

describe('SceneBoardComponent concluded scenes', () => {
    let restoreStorage: () => void;

    beforeEach(() => {
        restoreStorage = installMemoryStorage();
    });

    afterEach(() => restoreStorage());

    it('leaves a concluded scene out of the folder counts', () => {
        const {fixture, component} = setup();
        fixture.detectChanges();

        const folderA = component.tree().find(node => node.folder.id === 'a');
        expect(folderA?.count).toBe(2);
    });

    it('leaves a concluded scene out of the board groups', () => {
        const {fixture, component} = setup();
        fixture.detectChanges();

        const channelIds = component.groups().flatMap(g => g.rows.map(r => r.scene.channelId));
        expect(channelIds).not.toContain('done');
    });
});
