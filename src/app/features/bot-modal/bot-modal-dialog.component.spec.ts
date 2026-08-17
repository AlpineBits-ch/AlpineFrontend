import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {signal, WritableSignal} from '@angular/core';
import {Subject} from 'rxjs';
import {
    BotModalDialogComponent,
    buildModalSubmitRows,
    describeModalSubmitFailure,
    flattenModalRows,
    ModalField,
    toModalField,
    validateModalField,
} from './bot-modal-dialog.component';
import {BotModalDialogService} from './bot-modal-dialog.service';
import {ApiConfigService} from '../../services/api-config.service';
import {
    BotComponentPayload,
    GuildWebsocketService,
    WsBotModalOpen,
} from '../../services/guild-websocket.service';
import {NavigationService} from '../main-page/navigation.service';

const SUBMIT_URL = 'https://api.test.example/api/v1/bots/guilds/gild_1/channels/chan_1/modal-submit';

/** One action row wrapping one text input - what a bot's modal actually looks like on the wire. */
function row(input: BotComponentPayload): BotComponentPayload {
    return {type: 1, components: [input]};
}

function textInput(over: Partial<BotComponentPayload> = {}): BotComponentPayload {
    return {type: 4, custom_id: 'summary', label: 'Summary', ...over};
}

function modal(over: Partial<WsBotModalOpen> = {}): WsBotModalOpen {
    return {
        guildId: 'gild_1',
        channelId: 'chan_1',
        botUserId: 'bot_1',
        customId: 'feedback-modal',
        title: 'Feedback',
        components: [row(textInput())],
        ...over,
    };
}

function setup(request: WsBotModalOpen | null = modal()) {
    const dialog = {
        request: signal<WsBotModalOpen | null>(request) as WritableSignal<WsBotModalOpen | null>,
        close: vi.fn(),
    };
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            {provide: BotModalDialogService, useValue: dialog},
            {
                provide: GuildWebsocketService,
                useValue: {
                    botInstalledObservable: new Subject(),
                    botUninstalledObservable: new Subject(),
                    messageObservable: new Subject(),
                },
            },
            {provide: NavigationService, useValue: {workspace: signal({type: 'dms'})}},
        ],
    });
    // Constructed directly rather than through a fixture: nothing here needs the template, and
    // rendering p-dialog into the document would buy a lot of PrimeNG for no extra coverage.
    const component = TestBed.runInInjectionContext(() => new BotModalDialogComponent());
    return {component, dialog, ctrl: TestBed.inject(HttpTestingController)};
}

describe('modal payload reading', () => {
    it('reads the wire names the server actually sends, not the contract camelCase', () => {
        const field = toModalField(
            textInput({
                custom_id: 'summary',
                label: 'What happened?',
                placeholder: 'Describe it',
                value: 'prefilled',
                required: true,
                min_length: 5,
                max_length: 200,
                style: 2,
            }),
            0,
        );

        expect(field).toEqual({
            key: '0:summary',
            customId: 'summary',
            label: 'What happened?',
            placeholder: 'Describe it',
            required: true,
            minLength: 5,
            maxLength: 200,
            paragraph: true,
            initialValue: 'prefilled',
            unsupported: false,
        } satisfies ModalField);
    });

    it('falls back to the custom_id for a label, and to a positional name for neither', () => {
        expect(toModalField({type: 4, custom_id: 'summary'}, 0).label).toBe('summary');
        expect(toModalField({type: 4, custom_id: 'x', label: '   '}, 2).label).toBe('x');
        expect(toModalField({type: 4, custom_id: ''}, 2).label).toBe('Field 3');
    });

    it('treats a non-text-input, and a text input with no custom_id, as unsupported', () => {
        expect(toModalField({type: 2, custom_id: 'press', label: 'Press'}, 0).unsupported).toBe(true);
        expect(toModalField({type: 4, label: 'Nameless'}, 0).unsupported).toBe(true);
        expect(toModalField(textInput(), 0).unsupported).toBe(false);
    });

    it('ignores nonsense length bounds rather than making a field permanently invalid', () => {
        const field = toModalField(textInput({min_length: -3, max_length: 0}), 0);
        expect(field.minLength).toBeNull();
        expect(field.maxLength).toBeNull();
    });

    it('flattens action rows and stops following a self-nesting payload', () => {
        expect(
            flattenModalRows([row(textInput({custom_id: 'a'})), row(textInput({custom_id: 'b'}))]),
        ).toEqual([textInput({custom_id: 'a'}), textInput({custom_id: 'b'})]);

        const cyclic: BotComponentPayload = {type: 1, components: []};
        cyclic.components = [cyclic];
        expect(flattenModalRows([cyclic])).toEqual([]);
    });
});

describe('modal field validation', () => {
    const field = (over: Partial<ModalField>): ModalField => ({
        key: 'k',
        customId: 'c',
        label: 'L',
        placeholder: '',
        required: false,
        minLength: null,
        maxLength: null,
        paragraph: false,
        initialValue: '',
        unsupported: false,
        ...over,
    });

    it('rejects a required field that holds only whitespace', () => {
        expect(validateModalField(field({required: true}), '   ')).toBe('This field is required.');
        expect(validateModalField(field({required: true}), 'x')).toBeNull();
    });

    it('leaves an untouched optional field alone even when it has a minimum length', () => {
        expect(validateModalField(field({minLength: 10}), '')).toBeNull();
        expect(validateModalField(field({minLength: 10}), 'short')).toBe('Must be at least 10 characters.');
    });

    it('rejects an over-long value', () => {
        expect(validateModalField(field({maxLength: 3}), 'abcd')).toBe('Must be at most 3 characters.');
        expect(validateModalField(field({maxLength: 3}), 'abc')).toBeNull();
    });
});

describe('modal submit body', () => {
    it('wraps every answered field in its own action row', () => {
        const fields = [
            toModalField(textInput({custom_id: 'a'}), 0),
            toModalField(textInput({custom_id: 'b'}), 1),
        ];
        expect(buildModalSubmitRows(fields, {'0:a': 'first', '1:b': 'second'})).toEqual([
            {type: 1, components: [{type: 4, custom_id: 'a', value: 'first'}]},
            {type: 1, components: [{type: 4, custom_id: 'b', value: 'second'}]},
        ]);
    });

    it('drops unsupported components rather than sending a row the bot cannot key on', () => {
        const fields = [
            toModalField({type: 2, custom_id: 'press', label: 'Press'}, 0),
            toModalField(textInput({custom_id: 'b'}), 1),
        ];
        expect(buildModalSubmitRows(fields, {'1:b': 'second'})).toEqual([
            {type: 1, components: [{type: 4, custom_id: 'b', value: 'second'}]},
        ]);
    });

    it('sends an empty string for a field the user left blank', () => {
        const fields = [toModalField(textInput({custom_id: 'a'}), 0)];
        expect(buildModalSubmitRows(fields, {})).toEqual([
            {type: 1, components: [{type: 4, custom_id: 'a', value: ''}]},
        ]);
    });
});

describe('BotModalDialogComponent', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('seeds the inputs with whatever the bot prefilled', () => {
        const {component} = setup(modal({components: [row(textInput({value: 'draft'}))]}));
        expect(component['form']().values).toEqual({'0:summary': 'draft'});
    });

    it('re-seeds when a second modal replaces the first, so no answer leaks across', () => {
        const {component, dialog} = setup(
            modal({components: [row(textInput({custom_id: 'a', value: 'one'}))]}),
        );
        component['setValue']('0:a', 'typed');

        dialog.request.set(modal({components: [row(textInput({custom_id: 'b', value: 'two'}))]}));

        expect(component['form']().values).toEqual({'0:b': 'two'});
    });

    it('POSTs the filled rows nested in action rows', () => {
        const {component, ctrl} = setup(
            modal({
                components: [
                    row(textInput({custom_id: 'summary'})),
                    row(textInput({custom_id: 'detail', style: 2})),
                ],
            }),
        );
        component['setValue']('0:summary', 'It broke');
        component['setValue']('1:detail', 'Repeatedly');
        component['submit']();

        const req = ctrl.expectOne(SUBMIT_URL);
        expect(req.request.body).toEqual({
            botUserId: 'bot_1',
            customId: 'feedback-modal',
            components: [
                {type: 1, components: [{type: 4, custom_id: 'summary', value: 'It broke'}]},
                {type: 1, components: [{type: 4, custom_id: 'detail', value: 'Repeatedly'}]},
            ],
        });
        req.flush(null, {status: 202, statusText: 'Accepted'});
    });

    it('closes on 202 without claiming the bot did anything', () => {
        const {component, dialog, ctrl} = setup();
        component['setValue']('0:summary', 'x');
        component['submit']();

        ctrl.expectOne(SUBMIT_URL).flush(null, {status: 202, statusText: 'Accepted'});

        expect(dialog.close).toHaveBeenCalled();
        expect(component['submitting']()).toBe(false);
        expect(component['form']().error).toBeNull();
    });

    it('holds a required field back instead of posting, and only then shows why', () => {
        const {component, ctrl} = setup(modal({components: [row(textInput({required: true}))]}));

        expect(component['form']().attempted).toBe(false);
        component['submit']();

        ctrl.expectNone(SUBMIT_URL);
        expect(component['form']().attempted).toBe(true);
        expect(component['fieldErrors']()['0:summary']).toBe('This field is required.');
    });

    it('posts once the required field is filled', () => {
        const {component, ctrl} = setup(modal({components: [row(textInput({required: true}))]}));
        component['submit']();
        component['setValue']('0:summary', 'answered');
        component['submit']();

        ctrl.expectOne(SUBMIT_URL).flush(null, {status: 202, statusText: 'Accepted'});
        expect(component['fieldErrors']()).toEqual({});
    });

    it('will not offer to submit a modal with no customId to correlate on', () => {
        const {component, ctrl} = setup(modal({customId: null}));
        expect(component['answerable']()).toBe(false);

        component['submit']();
        ctrl.expectNone(SUBMIT_URL);
    });

    it('will not offer to submit a modal with no guild, which the route needs in its path', () => {
        const {component, ctrl} = setup(modal({guildId: null}));
        expect(component['answerable']()).toBe(false);

        component['submit']();
        ctrl.expectNone(SUBMIT_URL);
    });

    it('explains a 403 as the channel permission it is, and stays open', () => {
        const {component, dialog, ctrl} = setup();
        component['submit']();
        ctrl.expectOne(SUBMIT_URL).flush('', {status: 403, statusText: 'Forbidden'});

        expect(component['form']().error).toBe(
            'You do not have permission to send messages in this channel, so this form cannot be submitted.',
        );
        expect(dialog.close).not.toHaveBeenCalled();
        expect(component['submitting']()).toBe(false);
    });

    it('explains a 404 as the bot being gone, not as a missing form', () => {
        const {component, ctrl} = setup();
        component['submit']();
        ctrl.expectOne(SUBMIT_URL).flush('Bot is not installed in this guild.', {
            status: 404,
            statusText: 'Not Found',
        });

        expect(component['form']().error).toBe(
            'This bot is no longer available in this server, so it cannot receive this form.',
        );
    });

    it('distinguishes never reaching the server from being refused by it', () => {
        const {component, ctrl} = setup();
        component['submit']();
        ctrl.expectOne(SUBMIT_URL).error(new ProgressEvent('error'));

        expect(component['form']().error).toBe(
            'Could not reach the server. Check your connection and try again.',
        );
    });

    it('clears a previous failure when the user tries again', () => {
        const {component, ctrl} = setup();
        component['submit']();
        ctrl.expectOne(SUBMIT_URL).flush('', {status: 403, statusText: 'Forbidden'});
        expect(component['form']().error).not.toBeNull();

        component['submit']();
        const retry = ctrl.expectOne(SUBMIT_URL);
        expect(component['form']().error).toBeNull();
        retry.flush(null, {status: 202, statusText: 'Accepted'});
    });

    it('ignores a second Submit while one is in flight', () => {
        const {component, ctrl} = setup();
        component['submit']();
        component['submit']();

        ctrl.expectOne(SUBMIT_URL).flush(null, {status: 202, statusText: 'Accepted'});
    });
});

describe('describeModalSubmitFailure', () => {
    it('falls back to a generic message for anything that is not an HTTP error', () => {
        expect(describeModalSubmitFailure(new Error('boom'))).toBe('Something went wrong sending this form.');
    });
});
