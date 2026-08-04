import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService, TranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {MessageComponent} from './message.component';
import {ApiConfigService} from '../../../../../services/api-config.service';
import {MessageStore} from '../../../../../stores/message.store';
import {MessageDto} from '../../../../../dtos/response/message.dto';
import {MessageType} from '../../../../../enums/message-type.enum';
import {MessageEncryptionState} from '../../../../../enums/message-encryption-state.enum';
import {ChannelType} from '../../../../../dtos/response/guild.dto';

const BASE = 'https://api.test.example';

function messageFixture(overrides: Partial<MessageDto> = {}): MessageDto {
    return {
        id: 'm1',
        createdAt: new Date(),
        updatedAt: new Date(),
        content: btoa('hello world'),
        channelId: 'chan1',
        conversationId: undefined,
        authorId: 'author1',
        isPending: false,
        isFailed: false,
        attachments: [],
        inReplyTo: undefined,
        mentions: [],
        encryptionState: MessageEncryptionState.Plain,
        mlsEpoch: undefined,
        mlsSequenceNumber: undefined,
        senderDeviceId: undefined,
        type: MessageType.Message,
        ...overrides,
    };
}

async function setup(overrides: Partial<MessageDto> = {}, inputs: Record<string, unknown> = {}) {
    // configureTestingModule must not run against a TestBed another spec file left
    // instantiated, and compileComponents returns a promise that has to be awaited -
    // leaving it floating lets it settle during a later file's test and corrupts the
    // shared TestBed singleton.
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
        imports: [MessageComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService({defaultLanguage: 'en'}),
            MessageService,
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
            // MessageStore's dependency chain reaches MlsService, which touches
            // @tauri-apps/plugin-store at construction time - unusable under jsdom.
            // These tests only exercise MessageComponent's own publish() latch, so a
            // bare stub (nothing here is ever called from that code path) is enough.
            {
                provide: MessageStore,
                useValue: {
                    getOrFetchMessage: () => {
                        throw new Error('not expected to be called in publish() specs');
                    },
                    applyEmbedSuppression: vi.fn(),
                },
            },
        ],
    }).compileComponents();

    const fixture: ComponentFixture<MessageComponent> = TestBed.createComponent(MessageComponent);
    fixture.componentRef.setInput('message', messageFixture(overrides));
    fixture.componentRef.setInput('channelType', ChannelType.Announcement);
    fixture.componentRef.setInput('canPinMessages', true);
    for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
    const component = fixture.componentInstance;
    const ctrl = TestBed.inject(HttpTestingController);
    const messageService = TestBed.inject(MessageService);
    return {fixture, component, ctrl, messageService};
}

const PUBLISH_URL = `${BASE}/api/v1/messaging/messaging/m1/publish`;

describe('MessageComponent publish()', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('sends exactly one POST when publish() is called twice before the first response arrives (double-click race)', async () => {
        const {component, ctrl} = await setup();

        (component as unknown as { publish(): void }).publish();
        (component as unknown as { publish(): void }).publish();

        ctrl.expectOne(PUBLISH_URL);
        // If the in-flight guard didn't take effect synchronously, expectOne above
        // would already have thrown for finding 2 matching requests.
    });

    it('latches published() and clears publishing() after a successful publish', async () => {
        const {component, ctrl} = await setup();
        const c = component as unknown as { publish(): void; published: () => boolean; publishing: () => boolean };

        c.publish();
        expect(c.publishing()).toBe(true);
        expect(c.published()).toBe(false);

        const req = ctrl.expectOne(PUBLISH_URL);
        req.flush({published: 3});

        expect(c.published()).toBe(true);
        expect(c.publishing()).toBe(false);
    });

    it('releases publishing() without latching published() after a failed publish, allowing a retry', async () => {
        const {component, ctrl} = await setup();
        const c = component as unknown as { publish(): void; published: () => boolean; publishing: () => boolean };

        c.publish();
        const req = ctrl.expectOne(PUBLISH_URL);
        req.flush('server error', {status: 500, statusText: 'Internal Server Error'});

        expect(c.published()).toBe(false);
        expect(c.publishing()).toBe(false);

        // Retry must be allowed to actually reach the server this time.
        c.publish();
        ctrl.expectOne(PUBLISH_URL).flush({published: 1});
        expect(c.published()).toBe(true);
    });

    it('routes {published: 0} to the success toast, not the error toast', async () => {
        const {component, ctrl, messageService} = await setup();
        const c = component as unknown as { publish(): void };
        const addSpy = vi.spyOn(messageService, 'add');

        c.publish();
        const req = ctrl.expectOne(PUBLISH_URL);
        req.flush({published: 0});

        expect(addSpy).toHaveBeenCalledTimes(1);
        expect(addSpy.mock.calls[0][0]).toEqual(expect.objectContaining({severity: 'success'}));
    });

    it('picks the singular translation key when exactly one channel received the publish', async () => {
        const {component, ctrl} = await setup();
        const c = component as unknown as { publish(): void };
        const translate = TestBed.inject(TranslateService);
        const instantSpy = vi.spyOn(translate, 'instant');

        c.publish();
        ctrl.expectOne(PUBLISH_URL).flush({published: 1});

        expect(instantSpy).toHaveBeenCalledWith('MESSAGE.PUBLISH_SUCCESS_SINGULAR', expect.anything());
        expect(instantSpy).not.toHaveBeenCalledWith('MESSAGE.PUBLISH_SUCCESS', expect.anything());
    });

    it('picks the plural translation key when more than one channel received the publish', async () => {
        const {component, ctrl} = await setup();
        const c = component as unknown as { publish(): void };
        const translate = TestBed.inject(TranslateService);
        const instantSpy = vi.spyOn(translate, 'instant');

        c.publish();
        ctrl.expectOne(PUBLISH_URL).flush({published: 4});

        expect(instantSpy).toHaveBeenCalledWith('MESSAGE.PUBLISH_SUCCESS', expect.anything());
        expect(instantSpy).not.toHaveBeenCalledWith('MESSAGE.PUBLISH_SUCCESS_SINGULAR', expect.anything());
    });
});

describe('MessageComponent link previews', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('parses embedsJson, and shrugs off anything that is not an embed array', async () => {
        const {fixture, component} = await setup({embedsJson: '[{"type":"link","title":"Example"}]'});
        expect(component.embeds()).toHaveLength(1);
        expect(component.embeds()[0].title).toBe('Example');

        // Whatever else the field turns out to hold, it must not take the message list down.
        fixture.componentRef.setInput('message', messageFixture({embedsJson: 'not json'}));
        expect(component.embeds()).toEqual([]);
        fixture.componentRef.setInput('message', messageFixture({embedsJson: '{"not":"an array"}'}));
        expect(component.embeds()).toEqual([]);
    });

    /**
     * The whole point of the editedAt/updatedAt split: a preview attaching bumps updatedAt a second
     * after the message is posted, which used to be enough to label it "(edited)" by nobody.
     */
    it('marks a message edited only when the author edited it', async () => {
        const {fixture, component} = await setup({
            createdAt: new Date('2026-08-04T10:00:00Z'),
            updatedAt: new Date('2026-08-04T10:00:05Z'),
            embedsJson: '[{"type":"link"}]',
        });
        expect(component.isEdited()).toBe(false);

        fixture.componentRef.setInput('message', messageFixture({editedAt: '2026-08-04T10:01:00Z'}));
        expect(component.isEdited()).toBe(true);
    });

    it('reads the suppress bit out of the message flags', async () => {
        const {fixture, component} = await setup({flags: 0});
        expect(component.embedsSuppressed()).toBe(false);

        fixture.componentRef.setInput('message', messageFixture({flags: 4}));
        expect(component.embedsSuppressed()).toBe(true);
        // Other bits must not read as a suppression.
        fixture.componentRef.setInput('message', messageFixture({flags: 1 | 2}));
        expect(component.embedsSuppressed()).toBe(false);
    });

    it('shows the text of a message that also carries a card', async () => {
        // This used to be "render the text only when there are no embeds", which swallowed the
        // message the moment its preview arrived.
        const {component} = await setup({
            content: btoa('look at this https://example.com'),
            embedsJson: '[{"type":"link"}]',
        });
        expect(component.hasRenderableContent()).toBe(true);
    });

    it('strips the sender\'s no-preview brackets from the displayed text only', async () => {
        const {component} = await setup({content: btoa('see <https://example.com> for more')});

        expect(component.displayContent()).toBe('see https://example.com for more');
        // The raw body keeps them, so an edit round-trips the opt-out instead of silently
        // re-enabling a preview the sender suppressed.
        expect(component.content()).toBe('see <https://example.com> for more');
    });

    it('offers a restore only where a preview could actually come back', async () => {
        const linked = await setup(
            {content: btoa('https://example.com'), flags: 4, channelId: 'chan1'},
            {canDeleteAnyMessage: true});
        expect(linked.component.canRestoreEmbeds()).toBe(true);

        // No link at all - nothing was ever unfurled, so there is nothing to restore.
        const bare = await setup({content: btoa('no links here'), flags: 4, channelId: 'chan1'},
            {canDeleteAnyMessage: true});
        expect(bare.component.canRestoreEmbeds()).toBe(false);

        // The server does not unfurl a URL inside a code span, so neither do we offer to.
        const fenced = await setup(
            {content: btoa('`https://example.com`'), flags: 4, channelId: 'chan1'},
            {canDeleteAnyMessage: true});
        expect(fenced.component.canRestoreEmbeds()).toBe(false);

        // Nor one the sender opted out of with angle brackets.
        const optedOut = await setup(
            {content: btoa('<https://example.com>'), flags: 4, channelId: 'chan1'},
            {canDeleteAnyMessage: true});
        expect(optedOut.component.canRestoreEmbeds()).toBe(false);
    });

    /** Rendering a ✕ the server would 403 is worse than not offering it. */
    it('offers the ✕ to a DeleteAnyMessage holder in a channel but never in a DM', async () => {
        const channel = await setup({channelId: 'chan1', conversationId: undefined},
            {canDeleteAnyMessage: true});
        expect(channel.component.canSuppressEmbeds()).toBe(true);

        const dm = await setup({channelId: undefined, conversationId: 'conv1'},
            {canDeleteAnyMessage: true});
        expect(dm.component.canSuppressEmbeds()).toBe(false);

        const unprivileged = await setup({channelId: 'chan1'}, {canDeleteAnyMessage: false});
        expect(unprivileged.component.canSuppressEmbeds()).toBe(false);
    });

    it('PATCHes the suppression and rolls the optimistic state back when that fails', async () => {
        const {component, ctrl} = await setup({channelId: 'chan1', embedsJson: '[{"type":"link"}]'},
            {canDeleteAnyMessage: true});
        const store = TestBed.inject(MessageStore) as unknown as { applyEmbedSuppression: ReturnType<typeof vi.fn> };

        component.toggleEmbedSuppression();

        expect(store.applyEmbedSuppression).toHaveBeenCalledWith('m1', true);
        const req = ctrl.expectOne(`${BASE}/api/v1/messaging/messaging/m1/embeds`);
        expect(req.request.method).toBe('PATCH');
        expect(req.request.body).toEqual({suppress: true});

        req.flush('nope', {status: 403, statusText: 'Forbidden'});
        // Rolled back with the embeds it had, since the card is gone from the store by now.
        expect(store.applyEmbedSuppression).toHaveBeenLastCalledWith('m1', false, '[{"type":"link"}]');
    });
});
