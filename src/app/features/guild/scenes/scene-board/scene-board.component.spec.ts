import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {of} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {SceneBoardComponent, SceneGroup} from './scene-board.component';
import {SceneService} from '../../../../services/scene.service';
import {SceneRailStateService} from '../../../../services/scene-rail-state.service';
import {SceneTaxonomyService} from '../../../../services/scene-taxonomy.service';
import {PersonaService} from '../../../../services/persona.service';
import {GuildService} from '../../../../services/guild.service';
import {ProfileService} from '../../../../services/profile.service';
import {ToastService} from '../../../../services/toast.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {SceneFolderDto, SceneListItemDto, SceneStatus} from '../../../../dtos/response/scene.dto';
import {installMemoryStorage} from '../../../../testing/memory-storage';

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

function setup(scenes = SCENES, folders = FOLDERS) {
    TestBed.configureTestingModule({
        imports: [SceneBoardComponent],
        providers: [
            provideTranslateService(),
            {
                provide: SceneService,
                useValue: {
                    scenes: () => scenes,
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
                    ensureGuild: () => undefined,
                },
            },
            {provide: PersonaService, useValue: {identity: () => null}},
            {
                provide: GuildService,
                useValue: {guilds: () => [{id: 'g1', channels: []}], getOwnMember: () => of(null)},
            },
            {provide: ProfileService, useValue: {ownProfile: () => ({userId: 'u1'})}},
            {
                provide: ToastService,
                useValue: {error: vi.fn(), httpError: vi.fn(), success: vi.fn(), warn: vi.fn()},
            },
            {
                provide: NavigationService,
                useValue: {
                    mainView: () => ({type: 'home'}) as const,
                    openChannel: vi.fn(),
                    openChannelFromStart: vi.fn(),
                    openScenes: vi.fn(),
                },
            },
        ],
    });

    const fixture: ComponentFixture<SceneBoardComponent> = TestBed.createComponent(SceneBoardComponent);
    fixture.componentRef.setInput('guildId', 'g1');
    fixture.detectChanges();
    return {
        fixture,
        component: fixture.componentInstance as unknown as {
            groups: () => SceneGroup[];
            tree: () => {folder: {id: string}; count: number}[];
            scenesByFolder: () => Record<string, {channelId: string}[]>;
            recent: () => {channelId: string}[];
            folderId: {set: (v: string | null) => void};
        },
    };
}

describe('SceneBoardComponent grouping', () => {
    let restoreStorage: () => void;

    beforeEach(() => {
        restoreStorage = installMemoryStorage();
    });

    afterEach(() => restoreStorage());

    it('groups by status while the rail is hidden', () => {
        const {fixture, component} = setup();
        TestBed.inject(SceneRailStateService).setRailVisible('g1', false);
        fixture.detectChanges();

        expect(component.groups().map(g => g.key)).toEqual(['yours', 'running']);
    });

    it('groups by folder once the rail is shown', () => {
        const {fixture, component} = setup();
        TestBed.inject(SceneRailStateService).setRailVisible('g1', true);
        fixture.detectChanges();

        const keys = component.groups().map(g => g.key);
        expect(keys[0]).toBe('yours');
        expect(keys).toContain('folder:a');
        expect(keys).toContain('folder:b');
        expect(keys.at(-1)).toBe('unfiled');
    });

    it('does not repeat a pinned scene inside its folder section', () => {
        const {fixture, component} = setup();
        TestBed.inject(SceneRailStateService).setRailVisible('g1', true);
        fixture.detectChanges();

        const actOne = component.groups().find(g => g.key === 'folder:a');
        expect(actOne?.rows.map(r => r.scene.channelId)).toEqual(['other']);
    });

    it('names the folder a pinned scene came from', () => {
        const {fixture, component} = setup();
        TestBed.inject(SceneRailStateService).setRailVisible('g1', true);
        fixture.detectChanges();

        const yours = component.groups().find(g => g.key === 'yours');
        expect(yours?.rows[0].folderPath).toBe('Act I');
    });

    it('names the whole path, not just the leaf folder, on a pinned row', () => {
        const {fixture, component} = setup(
            [scene({channelId: 'deep', name: 'The Long Road', folderId: 'a1', currentTurnPersonaId: 'p1'})],
            [...FOLDERS, folder('a1', 'Greyford', 0, 'a')],
        );
        TestBed.inject(SceneRailStateService).setRailVisible('g1', true);
        fixture.detectChanges();

        const yours = component.groups().find(g => g.key === 'yours');
        expect(yours?.rows[0].folderPath).toBe('Act I / Greyford');
    });

    it('shows only the chosen folder when one is selected', () => {
        const {fixture, component} = setup();
        TestBed.inject(SceneRailStateService).setRailVisible('g1', true);
        (fixture.componentInstance as unknown as {folderId: {set: (v: string | null) => void}}).folderId.set(
            'b',
        );
        fixture.detectChanges();

        const keys = component.groups().map(g => g.key);
        expect(keys).toEqual(['folder:b']);
    });

    it('keeps a scene waiting on you visible when its own folder is selected', () => {
        const {fixture, component} = setup();
        TestBed.inject(SceneRailStateService).setRailVisible('g1', true);
        (fixture.componentInstance as unknown as {folderId: {set: (v: string | null) => void}}).folderId.set(
            'a',
        );
        fixture.detectChanges();

        const rows = component.groups().flatMap(g => g.rows.map(r => r.scene.channelId));
        expect(rows).toContain('mine');
    });

    it('shows only the unfiled scene when the unfiled bucket is selected', () => {
        const {fixture, component} = setup();
        TestBed.inject(SceneRailStateService).setRailVisible('g1', true);
        component.folderId.set('unfiled');
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

    it('raises the same message the rail raises for a channel that is not in the guild', () => {
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

    it('leaves a concluded scene out of the rail leaves', () => {
        const {fixture, component} = setup();
        fixture.detectChanges();

        expect(component.scenesByFolder()['a']?.map(leaf => leaf.channelId)).not.toContain('done');
    });

    it('leaves a concluded scene out of the board groups', () => {
        const {fixture, component} = setup();
        TestBed.inject(SceneRailStateService).setRailVisible('g1', true);
        fixture.detectChanges();

        const channelIds = component.groups().flatMap(g => g.rows.map(r => r.scene.channelId));
        expect(channelIds).not.toContain('done');
    });

    it('leaves a concluded scene out of recent', () => {
        const {fixture, component} = setup();
        fixture.detectChanges();

        expect(component.recent().map(leaf => leaf.channelId)).not.toContain('done');
    });
});
