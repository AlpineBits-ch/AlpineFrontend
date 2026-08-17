import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService, TranslateService} from '@ngx-translate/core';
import {SystemMessageComponent} from './system-message.component';
import {ApiConfigService} from '../../../../../../services/api-config.service';
import {MessageDto} from '../../../../../../dtos/response/message.dto';
import {MessageType} from '../../../../../../enums/message-type.enum';
import {MessageEncryptionState} from '../../../../../../enums/message-encryption-state.enum';
import {toBase64} from '../../../../../../helpers/base64.helper';

const BASE = 'https://api.test.example';
const PROFILE_URL = `${BASE}/api/v1/social/profiles/by-user/user_1`;

function groupMessage(type: MessageType, content: string): MessageDto {
    return {
        id: 'mesg_1',
        createdAt: new Date(),
        updatedAt: new Date(),
        content: toBase64(content),
        channelId: undefined,
        conversationId: 'conv_1',
        authorId: 'user_1',
        isPending: false,
        isFailed: false,
        attachments: [],
        inReplyTo: undefined,
        mentions: [],
        encryptionState: MessageEncryptionState.Plain,
        mlsEpoch: undefined,
        mlsSequenceNumber: undefined,
        senderDeviceId: undefined,
        type,
    };
}

function setup(message: MessageDto) {
    TestBed.configureTestingModule({
        imports: [SystemMessageComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService({defaultLanguage: 'en', fallbackLang: 'en'}),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
        ],
    });

    TestBed.inject(TranslateService).setTranslation('en', {
        'MESSAGE.SYSTEM.GROUP_NAME_CHANGED': '%USER% named the group {{name}}',
        'MESSAGE.SYSTEM.GROUP_NAME_CLEARED': '%USER% removed the group name',
        'MESSAGE.SYSTEM.GROUP_ICON_CHANGED': '%USER% changed the group icon',
        'MESSAGE.SYSTEM.GROUP_ICON_REMOVED': '%USER% removed the group icon',
    });

    const fixture: ComponentFixture<SystemMessageComponent> = TestBed.createComponent(SystemMessageComponent);
    fixture.componentRef.setInput('message', message);
    const ctrl = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    return {fixture, component: fixture.componentInstance, ctrl};
}

describe('SystemMessageComponent group notices', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('names the group from the message content', () => {
        const {component, ctrl} = setup(groupMessage(MessageType.GroupNameChanged, 'Die Gummibaerenbande'));
        ctrl.expectOne(PROFILE_URL).flush({});

        expect(component.variantKey()).toBe('MESSAGE.SYSTEM.GROUP_NAME_CHANGED');
        expect(component.translateParams()).toEqual({name: 'Die Gummibaerenbande'});
    });

    it('reads empty content as the name having been cleared', () => {
        const {component, ctrl} = setup(groupMessage(MessageType.GroupNameChanged, ''));
        ctrl.expectOne(PROFILE_URL).flush({});

        expect(component.variantKey()).toBe('MESSAGE.SYSTEM.GROUP_NAME_CLEARED');
    });

    it('distinguishes a new icon from a removed one', () => {
        const changed = setup(groupMessage(MessageType.GroupIconChanged, ''));
        changed.ctrl.expectOne(PROFILE_URL).flush({});
        expect(changed.component.variantKey()).toBe('MESSAGE.SYSTEM.GROUP_ICON_CHANGED');

        TestBed.resetTestingModule();

        const removed = setup(groupMessage(MessageType.GroupIconChanged, 'removed'));
        removed.ctrl.expectOne(PROFILE_URL).flush({});
        expect(removed.component.variantKey()).toBe('MESSAGE.SYSTEM.GROUP_ICON_REMOVED');
    });

    it('renders the copy with the name substituted', () => {
        const {fixture, ctrl} = setup(groupMessage(MessageType.GroupNameChanged, 'Weekend'));
        ctrl.expectOne(PROFILE_URL).flush({});
        fixture.detectChanges();

        expect(fixture.nativeElement.textContent).toContain('named the group Weekend');
    });
});
