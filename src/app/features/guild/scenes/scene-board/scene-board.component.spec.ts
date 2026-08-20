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

function folder(id: string, name: string, position = 0): SceneFolderDto {
    return {id, guildId: 'g1', name, position, parentFolderId: null};
}

const SCENES = [
    scene({channelId: 'mine', name: 'The Ford at Dawn', folderId: 'a', currentTurnPersonaId: 'p1'}),
    scene({channelId: 'other', name: 'Nightwatch', folderId: 'a'}),
    scene({channelId: 'second', name: 'The Burning Gate', folderId: 'b'}),
    scene({channelId: 'loose', name: 'Council of Crows'}),
];

function setup() {
    TestBed.configureTestingModule({
        imports: [SceneBoardComponent],
        providers: [
            provideTranslateService(),
            {
                provide: SceneService,
                useValue: {
                    scenes: () => SCENES,
                    speakableIds: () => new Set(['p1']),
                    now: () => 0,
                    isLoading: () => false,
                    ensureGuild: () => undefined,
                },
            },
            {
                provide: SceneTaxonomyService,
                useValue: {
                    folders: () => [folder('a', 'Act I', 0), folder('b', 'Act II', 1)],
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
    return {fixture, component: fixture.componentInstance as unknown as {groups: () => SceneGroup[]}};
}

// jsdom implements no `matchMedia`, and PrimeNG's ContextMenu binds a listener to it in
// `ngOnInit`. Same stub `scene-folder-rail.component.spec.ts` uses.
beforeEach(() => {
    if (!window.matchMedia) {
        window.matchMedia = ((query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addEventListener: () => undefined,
            removeEventListener: () => undefined,
            addListener: () => undefined,
            removeListener: () => undefined,
            dispatchEvent: () => false,
        })) as unknown as typeof window.matchMedia;
    }
});

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
});
