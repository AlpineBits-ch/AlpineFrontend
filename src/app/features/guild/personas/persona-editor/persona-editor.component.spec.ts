import {TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection} from '@angular/core';
import {provideTranslateService} from '@ngx-translate/core';
import {Subject} from 'rxjs';
import {PersonaEditorComponent, PersonaEditorTarget} from './persona-editor.component';
import {PersonaService} from '../../../../services/persona.service';
import {ToastService} from '../../../../services/toast.service';
import {GuildPersonaDto, PersonaDto} from '../../../../dtos/response/persona.dto';

const STORED = 'https://venta.test/api/v1/guild/personas/pers_1/avatar?v=1';

function persona(over: Partial<PersonaDto> = {}): PersonaDto {
    return {
        id: 'pers_1',
        scope: 'User',
        name: 'Mayor Cogsgrove',
        avatarUrl: null,
        isRetired: false,
        createdAt: '2026-08-01T00:00:00Z',
        ...over,
    };
}

function entry(over: Partial<GuildPersonaDto> = {}): GuildPersonaDto {
    return {
        persona: persona(),
        personaId: 'pers_1',
        guildId: 'gild_1',
        approvalState: 'Approved',
        canSpeak: true,
        ...over,
    };
}

function setup(target: PersonaEditorTarget) {
    const calls: string[] = [];
    const track =
        <T>(name: string) =>
        () => {
            calls.push(name);
            return new Subject<T>();
        };

    const personas = {
        cast: () => [],
        entry: () => null,
        updateOwn: vi.fn(track<PersonaDto>('updateOwn')),
        updateGuildPersona: vi.fn(track<PersonaDto>('updateGuildPersona')),
        createOwn: vi.fn(track<PersonaDto>('createOwn')),
        createGuildPersona: vi.fn(track<GuildPersonaDto>('createGuildPersona')),
        saveProfile: vi.fn(track<GuildPersonaDto>('saveProfile')),
        uploadAvatar: vi.fn(track<PersonaDto>('uploadAvatar')),
        removeAvatar: vi.fn(track<void>('removeAvatar')),
        uploadProfileAvatar: vi.fn(track<GuildPersonaDto>('uploadProfileAvatar')),
        removeProfileAvatar: vi.fn(track<GuildPersonaDto>('removeProfileAvatar')),
    };

    const toast = {error: vi.fn(), httpError: vi.fn()};

    TestBed.configureTestingModule({
        providers: [
            provideZonelessChangeDetection(),
            provideTranslateService({defaultLanguage: 'en'}),
            {provide: PersonaService, useValue: personas},
            {provide: ToastService, useValue: toast},
        ],
    });

    const fixture = TestBed.createComponent(PersonaEditorComponent);
    fixture.componentRef.setInput('target', target);
    fixture.detectChanges();

    return {fixture, component: fixture.componentInstance, personas, toast, calls};
}

/** The result of the stubbed call, so a test can decide when each leg lands. */
function resultOf<T>(fn: {mock: {results: {value: unknown}[]}}, at = 0): Subject<T> {
    return fn.mock.results[at].value as Subject<T>;
}

function pick(component: PersonaEditorComponent, half: 'global' | 'guild'): void {
    const file = new File(['bytes'], 'avatar.png', {type: 'image/png'});
    (component as unknown as {pending: Record<string, {set: (f: File) => void}>}).pending[half].set(file);
}

describe('PersonaEditorComponent avatar writes', () => {
    it('uploads only after the persona write, which carries an avatarUrl of its own', () => {
        const {component, personas, calls} = setup({
            persona: persona({avatarUrl: STORED}),
            entry: null,
            guildId: null,
        });
        pick(component, 'global');

        component['save']();

        expect(calls).toEqual(['updateOwn']);

        resultOf<PersonaDto>(personas.updateOwn).next(persona());
        resultOf<PersonaDto>(personas.updateOwn).complete();

        expect(calls).toEqual(['updateOwn', 'uploadAvatar']);
    });

    it('creates the character first and uploads against the id it came back with', () => {
        const {component, personas, calls} = setup({persona: null, entry: null, guildId: null});
        // A create starts blank, and the save button is off until the character has a name.
        component['name'].set('Mayor Cogsgrove');
        pick(component, 'global');

        component['save']();

        expect(calls).toEqual(['createOwn']);

        resultOf<PersonaDto>(personas.createOwn).next(persona({id: 'pers_new'}));
        resultOf<PersonaDto>(personas.createOwn).complete();

        expect(personas.uploadAvatar).toHaveBeenCalledWith('pers_new', expect.any(File));
    });

    it('clears through the delete route and echoes the stored url in the body', () => {
        const {component, personas} = setup({
            persona: persona({avatarUrl: STORED}),
            entry: null,
            guildId: null,
        });

        component['clearAvatar']('global');
        component['save']();

        // Sending null here would clear the column, and the delete route would then find nothing to
        // remove and leave the bytes in storage.
        expect(personas.updateOwn).toHaveBeenCalledWith(
            'pers_1',
            expect.objectContaining({avatarUrl: STORED}),
        );

        resultOf<PersonaDto>(personas.updateOwn).next(persona());
        resultOf<PersonaDto>(personas.updateOwn).complete();

        expect(personas.removeAvatar).toHaveBeenCalledWith('pers_1');
    });

    it('does not call the delete route for a character that never had an avatar', () => {
        const {component, personas} = setup({persona: persona(), entry: null, guildId: null});

        component['clearAvatar']('global');
        component['save']();

        resultOf<PersonaDto>(personas.updateOwn).next(persona());
        resultOf<PersonaDto>(personas.updateOwn).complete();

        expect(personas.removeAvatar).not.toHaveBeenCalled();
    });

    it('sends the guild override to the profile route, not to the character', () => {
        const {component, personas} = setup({
            persona: persona(),
            entry: entry(),
            guildId: 'gild_1',
        });
        pick(component, 'guild');

        component['save']();

        resultOf<PersonaDto>(personas.updateOwn).next(persona());
        resultOf<PersonaDto>(personas.updateOwn).complete();
        resultOf<GuildPersonaDto>(personas.saveProfile).next(entry());
        resultOf<GuildPersonaDto>(personas.saveProfile).complete();

        expect(personas.uploadProfileAvatar).toHaveBeenCalledWith('gild_1', 'pers_1', expect.any(File));
        expect(personas.uploadAvatar).not.toHaveBeenCalled();
    });

    it('leaves the guild override alone when the character is not adopted here', () => {
        const {component, personas} = setup({persona: persona(), entry: null, guildId: 'gild_1'});
        pick(component, 'guild');

        component['save']();

        resultOf<PersonaDto>(personas.updateOwn).next(persona());
        resultOf<PersonaDto>(personas.updateOwn).complete();

        expect(personas.uploadProfileAvatar).not.toHaveBeenCalled();
    });

    it('still counts as saved when only the picture fails', () => {
        const {component, personas, toast} = setup({persona: persona(), entry: null, guildId: null});
        pick(component, 'global');

        const saved = vi.fn();
        const closed = vi.fn();
        component.saved.subscribe(saved);
        component.closed.subscribe(closed);

        component['save']();
        resultOf<PersonaDto>(personas.updateOwn).next(persona());
        resultOf<PersonaDto>(personas.updateOwn).complete();
        resultOf<PersonaDto>(personas.uploadAvatar).error(new Error('507'));

        expect(toast.httpError).toHaveBeenCalled();
        expect(saved).toHaveBeenCalled();
        expect(closed).toHaveBeenCalled();
    });

    it('reopening the dialog drops a picture the last character never saved', () => {
        const {component, fixture, personas} = setup({persona: persona(), entry: null, guildId: null});
        pick(component, 'global');

        fixture.componentRef.setInput('target', {
            persona: persona({id: 'pers_2'}),
            entry: null,
            guildId: null,
        });
        fixture.detectChanges();

        component['save']();
        resultOf<PersonaDto>(personas.updateOwn).next(persona());
        resultOf<PersonaDto>(personas.updateOwn).complete();

        expect(personas.uploadAvatar).not.toHaveBeenCalled();
    });
});
