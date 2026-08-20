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

function rows(fixture: ComponentFixture<SceneFolderPickerComponent>): HTMLButtonElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.pick-row'));
}

function rowFor(fixture: ComponentFixture<SceneFolderPickerComponent>, text: string): HTMLButtonElement {
    const match = rows(fixture).find(row => row.textContent?.trim().includes(text));
    if (!match) throw new Error(`no row for "${text}"`);
    return match;
}

function search(fixture: ComponentFixture<SceneFolderPickerComponent>, query: string): void {
    const input: HTMLInputElement = fixture.nativeElement.querySelector('input[type="search"]');
    input.value = query;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
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

    it('hides the unfiled row once a search is active', () => {
        const {fixture} = setup();

        expect(() => rowFor(fixture, 'SCENE.ARCHIVE.UNFILED')).not.toThrow();

        search(fixture, 'Greyford');

        expect(rows(fixture).some(row => row.textContent?.includes('SCENE.ARCHIVE.UNFILED'))).toBe(false);
    });

    it('prefixes a search hit with its parent name', () => {
        const {fixture} = setup();

        search(fixture, 'Greyford');

        const hit = rowFor(fixture, 'Greyford');
        const prefix = hit.querySelector('.pick-parent');
        expect(prefix?.textContent?.trim()).toBe('Act I /');
    });

    it('marks the row matching the selected input as current', () => {
        const {fixture} = setup();
        fixture.componentRef.setInput('selected', 'a1');
        fixture.detectChanges();

        expect(rowFor(fixture, 'Greyford').classList.contains('is-current')).toBe(true);
        expect(rowFor(fixture, 'Act I').classList.contains('is-current')).toBe(false);
        expect(rowFor(fixture, 'SCENE.ARCHIVE.UNFILED').classList.contains('is-current')).toBe(false);
    });

    it('marks unfiled as current when selected is null', () => {
        const {fixture} = setup();

        expect(rowFor(fixture, 'SCENE.ARCHIVE.UNFILED').classList.contains('is-current')).toBe(true);
    });
});
