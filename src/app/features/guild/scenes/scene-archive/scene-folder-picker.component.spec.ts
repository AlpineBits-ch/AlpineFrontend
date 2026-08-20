import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {describe, expect, it} from 'vitest';

import {SceneFolderPickerComponent} from './scene-folder-picker.component';
import {SceneTaxonomyService} from '../../../../services/scene-taxonomy.service';
import {SceneFolderDto} from '../../../../dtos/response/scene.dto';

function folder(id: string, name: string, parentFolderId: string | null = null): SceneFolderDto {
    return {id, guildId: 'g1', name, position: 0, parentFolderId};
}

const FOLDERS = [folder('a', 'Act I'), folder('a1', 'Greyford', 'a'), folder('b', 'Finale')];

function setup(): {
    fixture: ComponentFixture<SceneFolderPickerComponent>;
    component: SceneFolderPickerComponent;
} {
    TestBed.configureTestingModule({
        imports: [SceneFolderPickerComponent],
        providers: [
            provideTranslateService(),
            {provide: SceneTaxonomyService, useValue: {folders: () => FOLDERS, ensureGuild: () => undefined}},
        ],
    });
    const fixture = TestBed.createComponent(SceneFolderPickerComponent);
    fixture.componentRef.setInput('guildId', 'g1');
    fixture.detectChanges();
    return {fixture, component: fixture.componentInstance};
}

function reach(component: SceneFolderPickerComponent): Record<string, (...args: never[]) => unknown> {
    return component as unknown as Record<string, (...args: never[]) => unknown>;
}

describe('SceneFolderPickerComponent', () => {
    it('lists every parent followed by its own children', () => {
        const {component} = setup();

        const rows = (
            component as unknown as {folderMatches: () => {folder: SceneFolderDto; child: boolean}[]}
        ).folderMatches();

        expect(rows.map(r => r.folder.id)).toEqual(['a', 'a1', 'b']);
        expect(rows[1].child).toBe(true);
    });

    it('searches on the parent name too', () => {
        const {component} = setup();

        (component as unknown as {folderQuery: {set: (v: string) => void}}).folderQuery.set('Act I');
        const rows = (
            component as unknown as {folderMatches: () => {folder: SceneFolderDto}[]}
        ).folderMatches();

        expect(rows.map(r => r.folder.id)).toEqual(['a', 'a1']);
    });

    it('reports the chosen folder', () => {
        const {component} = setup();
        const picks: (string | null)[] = [];
        component.picked.subscribe(id => picks.push(id));

        reach(component)['choose']('a1' as never);

        expect(picks).toEqual(['a1']);
    });

    it('reports unfiled as null', () => {
        const {component} = setup();
        const picks: (string | null)[] = [];
        component.picked.subscribe(id => picks.push(id));

        reach(component)['choose'](null as never);

        expect(picks).toEqual([null]);
    });
});
