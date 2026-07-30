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

async function setup() {
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
                },
            },
        ],
    }).compileComponents();

    const fixture: ComponentFixture<MessageComponent> = TestBed.createComponent(MessageComponent);
    fixture.componentRef.setInput('message', messageFixture());
    fixture.componentRef.setInput('channelType', ChannelType.Announcement);
    fixture.componentRef.setInput('canPinMessages', true);
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
