/**
 * Characterization of the rail's reordering. Written against the two-level rail before the tree
 * rewrite, so a green run after it is evidence the folder maths survived.
 */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {beforeEach, describe, expect, it} from 'vitest';

import {SceneFolderRailComponent} from './scene-folder-rail.component';
import {folderTree} from './folder-tree';
import {SceneFolderDto, SceneStatus} from '../../../../dtos/response/scene.dto';

// jsdom implements no `matchMedia`, and PrimeNG's ContextMenu binds a listener to it in
// `ngOnInit`. Same stub `conversation-list-paging.spec.ts` uses.
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

/** Two roots with two children under the first, which is every shape the reorder code branches on. */
const FOLDERS = [folder('a', null, 0), folder('b', null, 1), folder('a1', 'a', 0), folder('a2', 'a', 1)];

function setup(): {fixture: ComponentFixture<SceneFolderRailComponent>; component: SceneFolderRailComponent} {
    TestBed.configureTestingModule({
        imports: [SceneFolderRailComponent],
        providers: [provideTranslateService()],
    });
    const fixture = TestBed.createComponent(SceneFolderRailComponent);
    fixture.componentRef.setInput('tree', folderTree(FOLDERS, {}));
    fixture.componentRef.setInput('canManage', true);
    fixture.detectChanges();
    return {fixture, component: fixture.componentInstance};
}

/** Reaches past `protected` on purpose: these are the methods under characterization. */
function reach(component: SceneFolderRailComponent): Record<string, (...args: never[]) => unknown> {
    return component as unknown as Record<string, (...args: never[]) => unknown>;
}

describe('SceneFolderRailComponent reordering', () => {
    let component: SceneFolderRailComponent;
    let emitted: string[][];

    beforeEach(() => {
        component = setup().component;
        emitted = [];
        component.reordered.subscribe(ids => emitted.push(ids));
    });

    it('emits every folder depth first when a root moves down', () => {
        reach(component)['nudge'](component.tree()[0] as never, 1 as never);

        expect(emitted[0]).toEqual(['b', 'a', 'a1', 'a2']);
    });

    it('emits every folder depth first when a child moves down', () => {
        reach(component)['nudge'](component.tree()[0].children[0] as never, 1 as never);

        expect(emitted[0]).toEqual(['a', 'a2', 'a1', 'b']);
    });

    it('says nothing when a nudge would leave the group', () => {
        reach(component)['nudge'](component.tree()[0] as never, -1 as never);

        expect(emitted).toEqual([]);
    });

    it('finds a root among the roots and a child among its siblings', () => {
        expect(reach(component)['siblingsOf']('a' as never)).toMatchObject({parentId: null});
        expect(reach(component)['siblingsOf']('a1' as never)).toMatchObject({parentId: 'a'});
        expect(reach(component)['siblingsOf']('nope' as never)).toBeNull();
    });
});

describe('SceneFolderRailComponent menu', () => {
    it('offers no menu to a reader who cannot manage scenes', () => {
        TestBed.configureTestingModule({
            imports: [SceneFolderRailComponent],
            providers: [provideTranslateService()],
        });
        const fixture = TestBed.createComponent(SceneFolderRailComponent);
        fixture.componentRef.setInput('tree', folderTree(FOLDERS, {}));
        fixture.componentRef.setInput('canManage', false);
        fixture.detectChanges();

        const event = new MouseEvent('contextmenu');
        reach(fixture.componentInstance)['openMenu'](
            event as never,
            fixture.componentInstance.tree()[0] as never,
        );

        expect((fixture.componentInstance as unknown as {menuItems: () => unknown[]}).menuItems()).toEqual(
            [],
        );
    });

    it('builds a menu for a folder that can be managed', () => {
        const {component} = setup();

        reach(component)['openMenu'](new MouseEvent('contextmenu') as never, component.tree()[0] as never);

        const labels = (component as unknown as {menuItems: () => {label?: string}[]}).menuItems();
        expect(labels.length).toBeGreaterThan(4);
    });
});

describe('SceneFolderRailComponent tree', () => {
    it('says nothing about a shelf nobody has opened', () => {
        const {fixture} = setup();
        fixture.componentRef.setInput('scenesByFolder', {
            a: [{channelId: 'ch_1', name: 'The Ford at Dawn', status: SceneStatus.Active, mine: false}],
        });
        fixture.detectChanges();

        expect(fixture.nativeElement.textContent).not.toContain('The Ford at Dawn');
    });

    it('draws the scenes of a shelf once it is open', () => {
        const {fixture} = setup();
        fixture.componentRef.setInput('scenesByFolder', {
            a: [{channelId: 'ch_1', name: 'The Ford at Dawn', status: SceneStatus.Active, mine: false}],
        });
        fixture.componentRef.setInput('expandedIds', ['a']);
        fixture.detectChanges();

        expect(fixture.nativeElement.textContent).toContain('The Ford at Dawn');
    });

    it('draws the recent block above everything', () => {
        const {fixture} = setup();
        fixture.componentRef.setInput('recent', [
            {channelId: 'ch_9', name: 'Nightwatch', status: SceneStatus.Active, mine: true},
        ]);
        fixture.detectChanges();

        expect(fixture.nativeElement.textContent).toContain('Nightwatch');
    });

    it('reports a shelf being opened rather than opening it itself', () => {
        const {fixture, component} = setup();
        const toggles: string[] = [];
        component.toggled.subscribe(id => toggles.push(id));

        reach(component)['toggle']('a' as never);

        expect(toggles).toEqual(['a']);
        // The rail does not hold the state: the host does, and hands it back through expandedIds.
        expect(fixture.componentInstance.expandedIds()).toEqual([]);
    });

    it('offers new scene here at the top of a folder menu', () => {
        const {component} = setup();

        reach(component)['openMenu'](new MouseEvent('contextmenu') as never, component.tree()[0] as never);

        const items = (component as unknown as {menuItems: () => {label?: string}[]}).menuItems();
        expect(items[0].label).toBe('SCENE.ARCHIVE.NEW_SCENE_HERE');
    });

    it('names the folder when new scene here is chosen', () => {
        const {component} = setup();
        const asked: (string | null)[] = [];
        component.createScene.subscribe(id => asked.push(id));

        reach(component)['openMenu'](new MouseEvent('contextmenu') as never, component.tree()[0] as never);
        const items = (component as unknown as {menuItems: () => {command?: () => void}[]}).menuItems();
        items[0].command?.();

        expect(asked).toEqual(['a']);
    });

    it('stops a shelf at the leaf cap and offers the rest', () => {
        const {fixture, component} = setup();
        const many = Array.from({length: 20}, (_, i) => ({
            channelId: `ch_${i}`,
            name: `Scene ${i}`,
            status: SceneStatus.Active,
            mine: false,
        }));
        fixture.componentRef.setInput('scenesByFolder', {a: many});
        fixture.componentRef.setInput('expandedIds', ['a']);
        fixture.componentRef.setInput('leafCap', 3);
        fixture.detectChanges();

        expect(reach(component)['leavesOf']('a' as never)).toHaveLength(3);
        expect(reach(component)['overflowOf']('a' as never)).toBe(17);
        expect(fixture.nativeElement.textContent).not.toContain('Scene 19');
    });

    it('reports a leaf click as a scene to open', () => {
        const {component} = setup();
        const opened: string[] = [];
        component.openScene.subscribe(id => opened.push(id));

        reach(component)['open']('ch_1' as never);

        expect(opened).toEqual(['ch_1']);
    });
});
