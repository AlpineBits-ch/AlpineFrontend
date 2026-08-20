/**
 * Characterization of the rail's reordering. Written against the two-level rail before the tree
 * rewrite, so a green run after it is evidence the folder maths survived.
 */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {beforeEach, describe, expect, it} from 'vitest';

import {SceneFolderRailComponent} from './scene-folder-rail.component';
import {folderTree} from './folder-tree';
import {SceneFolderDto} from '../../../../dtos/response/scene.dto';

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
