import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {of, throwError} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';

import {SceneDialogComponent} from './scene-dialog.component';
import {SceneService} from '../../../../services/scene.service';
import {PersonaService} from '../../../../services/persona.service';
import {SceneTaxonomyService} from '../../../../services/scene-taxonomy.service';
import {ToastService} from '../../../../services/toast.service';
import {SceneDto, SceneStatus} from '../../../../dtos/response/scene.dto';
import {ChannelDto, ChannelType} from '../../../../dtos/response/guild.dto';

function created(): SceneDto {
    return {
        channelId: 'ch_new',
        guildId: 'g1',
        name: 'The Ford at Dawn',
        status: SceneStatus.Open,
        turnOrder: ['p1'],
        participants: [],
    };
}

function channel(): ChannelDto {
    return {id: 'home', name: 'roleplay', type: ChannelType.Text, guildId: 'g1'} as ChannelDto;
}

function setup(fileResult: 'ok' | 'fail' = 'ok') {
    const scenes = {
        create: vi.fn(() => of(created())),
        update: vi.fn(() => (fileResult === 'ok' ? of(created()) : throwError(() => new Error('nope')))),
    };
    const toast = {success: vi.fn(), warn: vi.fn(), httpError: vi.fn()};
    const personas = {
        ensureCast: () => undefined,
        ensureGuildCast: () => undefined,
        guildCast: () => [],
        isGuildCastLoading: () => false,
        identity: () => null,
    };

    TestBed.configureTestingModule({
        imports: [SceneDialogComponent],
        providers: [
            provideTranslateService(),
            {provide: SceneService, useValue: scenes},
            {provide: PersonaService, useValue: personas},
            {provide: ToastService, useValue: toast},
            {provide: SceneTaxonomyService, useValue: {folder: () => null, ensureGuild: () => undefined}},
        ],
    });

    const fixture: ComponentFixture<SceneDialogComponent> = TestBed.createComponent(SceneDialogComponent);
    fixture.componentRef.setInput('guildId', 'g1');
    fixture.componentRef.setInput('guildChannels', [channel()]);
    fixture.detectChanges();

    const component = fixture.componentInstance as unknown as {
        name: {set: (v: string) => void};
        order: {set: (v: string[]) => void};
        save: (start: boolean) => void;
        chooseFolder: (folderId: string | null) => void;
    };
    component.name.set('The Ford at Dawn');
    component.order.set(['p1']);

    return {fixture, component, scenes, toast};
}

describe('SceneDialogComponent creating into a folder', () => {
    it('does not file when no folder was seeded', () => {
        const {component, scenes} = setup();

        component.save(false);

        expect(scenes.create).toHaveBeenCalledOnce();
        expect(scenes.update).not.toHaveBeenCalled();
    });

    it('files the scene it just created', () => {
        const {fixture, component, scenes} = setup();
        fixture.componentRef.setInput('seedFolderId', 'f1');

        component.save(false);

        expect(scenes.update).toHaveBeenCalledWith('g1', 'ch_new', {folderId: 'f1'});
    });

    it('reports a created scene even when filing it failed', () => {
        const {fixture, component, toast} = setup('fail');
        fixture.componentRef.setInput('seedFolderId', 'f1');

        component.save(false);

        // The scene exists. Calling this a failed create would send the GM to make a second one.
        expect(toast.warn).toHaveBeenCalled();
        expect(toast.httpError).not.toHaveBeenCalled();
    });

    it('closes after a create that could not be filed', () => {
        const {fixture, component} = setup('fail');
        fixture.componentRef.setInput('seedFolderId', 'f1');
        const closes: unknown[] = [];
        fixture.componentInstance.closed.subscribe(() => closes.push(1));

        component.save(false);

        expect(closes).toHaveLength(1);
    });

    it('keeps a hand-picked folder when the seed arrives again', () => {
        const {fixture, component, scenes} = setup();
        fixture.componentRef.setInput('seedFolderId', 'f1');
        fixture.detectChanges();

        component.chooseFolder('f2');

        // A late-arriving or repeated seed must not undo the game master's own pick.
        fixture.componentRef.setInput('seedFolderId', 'f1');
        fixture.detectChanges();

        component.save(false);

        expect(scenes.update).toHaveBeenCalledWith('g1', 'ch_new', {folderId: 'f2'});
    });

    it('honours an explicit unfiled over the seed', () => {
        const {fixture, component, scenes} = setup();
        fixture.componentRef.setInput('seedFolderId', 'f1');
        fixture.detectChanges();

        component.chooseFolder(null);

        component.save(false);

        expect(scenes.update).not.toHaveBeenCalled();
    });
});
