import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {NavigationService} from './navigation.service';
import {ConversationStore} from '../../stores/conversation.store';
import {ConversationDto} from '../../dtos/response/conversation.dto';
import {ConversationEncryption} from '../../enums/conversation-encryption.enum';
import {provideFakePlatform} from '../../platform/testing/provide-fake-platform';
import {ApiConfigService} from '../../services/api-config.service';
import {MessagingWebsocketService} from '../../services/messaging-websocket.service';
import {Subject} from 'rxjs';

const store = new Map<string, string>();

beforeAll(() => {
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, String(v)),
            removeItem: (k: string) => void store.delete(k),
            clear: () => store.clear(),
        },
    });
});

function conversation(name: string): ConversationDto {
    return {
        id: 'conv_1',
        createdAt: new Date(),
        updatedAt: new Date(),
        name,
        iconUpdatedAt: null,
        members: [],
        encryptionState: ConversationEncryption.Plain,
    };
}

/** Only the streams ConversationStore subscribes to on init. */
function fakeWebsocket() {
    return {
        conversationCreatedObservable: new Subject<string>(),
        messageObservable: new Subject<unknown>(),
        conversationRemovedObservable: new Subject<unknown>(),
        conversationUpdatedObservable: new Subject<unknown>(),
        conversationMemberRemovedObservable: new Subject<unknown>(),
    };
}

function setup(): {nav: NavigationService; conversations: InstanceType<typeof ConversationStore>} {
    store.clear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideFakePlatform(),
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            {provide: MessagingWebsocketService, useValue: fakeWebsocket()},
        ],
    });
    return {nav: TestBed.inject(NavigationService), conversations: TestBed.inject(ConversationStore)};
}

describe('NavigationService.activeConversation', () => {
    it('follows a rename made after the conversation was opened', () => {
        const {nav, conversations} = setup();
        const opened = conversation('Old');
        conversations.addConversation(opened);
        nav.openConversation(opened);

        conversations.applyEdit('conv_1', 'New', null);

        // The view still holds the copy it was opened with; every surface must read past it.
        expect(nav.activeConversation()?.name).toBe('New');
        const view = nav.mainView();
        expect(view.type === 'conversation' && view.conversation.name).toBe('Old');
    });

    it('follows an icon change too', () => {
        const {nav, conversations} = setup();
        const opened = conversation('Group');
        conversations.addConversation(opened);
        nav.openConversation(opened);

        conversations.applyEdit('conv_1', 'Group', '2026-08-17T19:24:49Z');

        expect(nav.activeConversation()?.iconUpdatedAt).toBe('2026-08-17T19:24:49Z');
    });

    it('falls back to the opened copy for a conversation the store does not hold', () => {
        const {nav} = setup();
        const opened = conversation('Unlisted');
        nav.openConversation(opened);

        expect(nav.activeConversation()).toBe(opened);
    });

    it('is null when the open view is not a conversation', () => {
        const {nav} = setup();
        nav.showHome();

        expect(nav.activeConversation()).toBeNull();
    });
});
