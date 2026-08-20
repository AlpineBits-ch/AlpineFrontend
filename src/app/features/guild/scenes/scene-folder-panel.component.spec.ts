import {ComponentFixture, TestBed} from '@angular/core/testing';
import {By} from '@angular/platform-browser';
import {provideTranslateService} from '@ngx-translate/core';
import {of, throwError} from 'rxjs';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {SceneFolderPanelComponent} from './scene-folder-panel.component';
import {folderTree} from './scene-archive/folder-tree';
import {SceneRailStateService} from '../../../services/scene-rail-state.service';
import {SceneTaxonomyService} from '../../../services/scene-taxonomy.service';
import {GuildService} from '../../../services/guild.service';
import {ToastService} from '../../../services/toast.service';
import {NavigationService} from '../../main-page/navigation.service';
import {SceneFolderDto} from '../../../dtos/response/scene.dto';
import {installMemoryStorage} from '../../../testing/memory-storage';

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

function folder(id: string, parentFolderId: string | null = null, position = 0): SceneFolderDto {
    return {id, guildId: 'g1', name: id.toUpperCase(), position, parentFolderId};
}

const CHANNEL = {id: 'ch_1', type: 0};

function setup(options?: {reorderFolders?: ReturnType<typeof vi.fn>; channels?: {id: string}[]}) {
    const toast = {error: vi.fn(), httpError: vi.fn(), success: vi.fn(), warn: vi.fn()};
    const nav = {openChannel: vi.fn(), openChannelFromStart: vi.fn()};
    const reorderFolders = options?.reorderFolders ?? vi.fn(() => of(undefined));

    TestBed.configureTestingModule({
        imports: [SceneFolderPanelComponent],
        providers: [
            provideTranslateService(),
            {provide: SceneTaxonomyService, useValue: {reorderFolders}},
            {
                provide: GuildService,
                useValue: {guilds: () => [{id: 'g1', channels: options?.channels ?? [CHANNEL]}]},
            },
            {provide: ToastService, useValue: toast},
            {provide: NavigationService, useValue: nav},
        ],
    });

    const fixture: ComponentFixture<SceneFolderPanelComponent> =
        TestBed.createComponent(SceneFolderPanelComponent);
    fixture.componentRef.setInput('guildId', 'g1');
    fixture.componentRef.setInput('tree', folderTree([folder('a')], {}));
    fixture.detectChanges();

    return {fixture, component: fixture.componentInstance, toast, nav, reorderFolders};
}

function reach(component: SceneFolderPanelComponent): Record<string, (...args: never[]) => unknown> {
    return component as unknown as Record<string, (...args: never[]) => unknown>;
}

describe('SceneFolderPanelComponent', () => {
    let restoreStorage: () => void;

    beforeEach(() => {
        restoreStorage = installMemoryStorage();
    });

    afterEach(() => restoreStorage());

    it('toggling a shelf writes through the rail state and comes back through what the rail receives', () => {
        const {fixture, component} = setup();
        const rail = fixture.debugElement.query(By.css('app-scene-folder-rail'));

        reach(component)['toggleShelf']('a' as never);
        fixture.detectChanges();

        expect(TestBed.inject(SceneRailStateService).expanded('g1')).toEqual(['a']);
        expect(rail.componentInstance.expandedIds()).toEqual(['a']);
    });

    it('calls the taxonomy service to reorder, and raises a toast on error', () => {
        const failing = vi.fn(() => throwError(() => new Error('nope')));
        const {component, toast} = setup({reorderFolders: failing});

        reach(component)['reorder'](['a', 'b'] as never);

        expect(failing).toHaveBeenCalledWith('g1', ['a', 'b']);
        expect(toast.httpError).toHaveBeenCalled();
    });

    it('re-emits createScene with the folder chosen for a new scene', () => {
        const {fixture, component} = setup();
        const asked: (string | null)[] = [];
        component.createScene.subscribe(id => asked.push(id));
        const rail = fixture.debugElement.query(By.css('app-scene-folder-rail'));

        rail.componentInstance.createScene.emit('a');

        expect(asked).toEqual(['a']);
    });

    it('opens from the start when the request says so', () => {
        const {component, nav} = setup();

        reach(component)['onOpenScene']('ch_1' as never, true as never);

        expect(nav.openChannelFromStart).toHaveBeenCalledWith(CHANNEL);
        expect(nav.openChannel).not.toHaveBeenCalled();
    });

    it('jumps to the latest post when the request does not ask for the start', () => {
        const {component, nav} = setup();

        reach(component)['onOpenScene']('ch_1' as never, false as never);

        expect(nav.openChannel).toHaveBeenCalledWith(CHANNEL);
        expect(nav.openChannelFromStart).not.toHaveBeenCalled();
    });

    it('raises a toast and never navigates for a channel that is not in the guild', () => {
        const {component, nav, toast} = setup({channels: []});

        reach(component)['onOpenScene']('ch_missing' as never, false as never);

        expect(toast.error).toHaveBeenCalledWith('SCENE.ARCHIVE.OPEN_ERROR', {
            detail: 'SCENE.ARCHIVE.OPEN_ERROR_DETAIL',
        });
        expect(nav.openChannel).not.toHaveBeenCalled();
        expect(nav.openChannelFromStart).not.toHaveBeenCalled();
    });
});
