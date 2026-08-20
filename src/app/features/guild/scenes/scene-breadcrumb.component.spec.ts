import {ComponentFixture, TestBed} from '@angular/core/testing';
import {By} from '@angular/platform-browser';
import {provideTranslateService} from '@ngx-translate/core';
import {describe, expect, it, vi} from 'vitest';

import {SceneBreadcrumbComponent} from './scene-breadcrumb.component';
import {SceneService} from '../../../services/scene.service';
import {SceneTaxonomyService} from '../../../services/scene-taxonomy.service';
import {NavigationService} from '../../main-page/navigation.service';
import {ChannelDto} from '../../../dtos/response/guild.dto';
import {SceneFolderDto, SceneListItemDto, SceneStatus} from '../../../dtos/response/scene.dto';

function folder(id: string, name: string, parentFolderId: string | null = null): SceneFolderDto {
    return {id, guildId: 'g1', name, position: 0, parentFolderId};
}

const CHANNEL = {id: 'ch_1', name: 'The Office', guildId: 'g1'} as unknown as ChannelDto;

function setup(options: {folderId?: string | null; folders?: SceneFolderDto[]} = {}) {
    const folders = options.folders ?? [];
    const row: SceneListItemDto = {
        channelId: 'ch_1',
        name: 'Act One',
        status: SceneStatus.Active,
        folderId: options.folderId ?? null,
    };
    const nav = {openSceneFolder: vi.fn(), closeSceneChannel: vi.fn()};

    TestBed.configureTestingModule({
        imports: [SceneBreadcrumbComponent],
        providers: [
            provideTranslateService(),
            {provide: SceneService, useValue: {scenes: () => [row], scene: () => null}},
            {
                provide: SceneTaxonomyService,
                useValue: {folder: (_g: string, id: string) => folders.find(f => f.id === id) ?? null},
            },
            {provide: NavigationService, useValue: nav},
        ],
    });

    const fixture: ComponentFixture<SceneBreadcrumbComponent> =
        TestBed.createComponent(SceneBreadcrumbComponent);
    fixture.componentRef.setInput('guildId', 'g1');
    fixture.componentRef.setInput('channel', CHANNEL);
    fixture.detectChanges();

    return {fixture, nav};
}

function crumbs(fixture: ComponentFixture<SceneBreadcrumbComponent>): string[] {
    return fixture.debugElement
        .queryAll(By.css('.crumb'))
        .map(el => (el.nativeElement as HTMLElement).textContent!.trim());
}

describe('SceneBreadcrumbComponent', () => {
    it('walks a scene two shelves deep from the root down', () => {
        const {fixture} = setup({
            folderId: 'child',
            folders: [folder('root', 'Act I'), folder('child', 'Greyford', 'root')],
        });

        expect(crumbs(fixture)).toEqual(['SCENE.BOARD.TITLE', 'Act I', 'Greyford', 'Act One']);
    });

    it('shows scenes and the scene alone when it sits on no shelf', () => {
        const {fixture} = setup({folderId: null});

        expect(crumbs(fixture)).toEqual(['SCENE.BOARD.TITLE', 'Act One']);
    });

    it('skips a shelf the guild has since deleted rather than drawing a dead segment', () => {
        const {fixture} = setup({folderId: 'gone', folders: [folder('root', 'Act I')]});

        expect(crumbs(fixture)).toEqual(['SCENE.BOARD.TITLE', 'Act One']);
    });

    it('a shelf segment lands on the archive filtered to it, with no scene open', () => {
        const {fixture, nav} = setup({folderId: 'root', folders: [folder('root', 'Act I')]});

        fixture.debugElement.queryAll(By.css('.crumb-link'))[1].nativeElement.click();

        expect(nav.openSceneFolder).toHaveBeenCalledWith('g1', 'root', 'archive');
    });

    it('the scenes link steps out of the shell', () => {
        const {fixture, nav} = setup();

        fixture.debugElement.queryAll(By.css('.crumb-link'))[0].nativeElement.click();

        expect(nav.closeSceneChannel).toHaveBeenCalledWith('g1');
    });
});
