import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService, TranslateService} from '@ngx-translate/core';
import {SystemMessageComponent} from './system-message.component';
import {ApiConfigService} from '../../../../../../services/api-config.service';
import {MessageDto} from '../../../../../../dtos/response/message.dto';
import {MessageType} from '../../../../../../enums/message-type.enum';
import {MessageEncryptionState} from '../../../../../../enums/message-encryption-state.enum';

const BASE = 'https://api.test.example';
const PROFILE_URL = `${BASE}/api/v1/social/profiles/by-user/user_1`;

function baseMessage(overrides: Partial<MessageDto> = {}): MessageDto {
    return {
        id: 'mesg_1',
        createdAt: new Date(),
        updatedAt: new Date(),
        content: '',
        channelId: 'chan_1',
        conversationId: undefined,
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
        type: MessageType.GuildMemberJoin,
        ...overrides,
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
        'MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.0': '%USER% joined the server',
        'MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.4': 'Glad you are here, %USER%',
        'MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.0': '%USER% left the server',
    });

    const fixture: ComponentFixture<SystemMessageComponent> = TestBed.createComponent(SystemMessageComponent);
    fixture.componentRef.setInput('message', message);
    const ctrl = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    return {fixture, component: fixture.componentInstance, ctrl};
}

describe('SystemMessageComponent variant selection', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('picks the GUILD_MEMBER_JOIN key at the given variant index', () => {
        const {component, ctrl} = setup(baseMessage({systemMessageVariant: 4}));
        ctrl.expectOne(PROFILE_URL).flush({userId: 'user_1', userName: 'Ada'});
        expect(component.variantKey()).toBe('MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.4');
    });

    it('picks the GUILD_MEMBER_LEAVE key when the message type is GuildMemberLeave', () => {
        const {component, ctrl} = setup(
            baseMessage({type: MessageType.GuildMemberLeave, systemMessageVariant: 0}),
        );
        ctrl.expectOne(PROFILE_URL).flush({userId: 'user_1', userName: 'Ada'});
        expect(component.variantKey()).toBe('MESSAGE.SYSTEM.GUILD_MEMBER_LEAVE.0');
    });

    it('defaults to variant 0 when systemMessageVariant is undefined', () => {
        const {component, ctrl} = setup(baseMessage({systemMessageVariant: undefined}));
        ctrl.expectOne(PROFILE_URL).flush({userId: 'user_1', userName: 'Ada'});
        expect(component.variantKey()).toBe('MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.0');
    });

    it('clamps an out-of-range variant back to 0', () => {
        const {component, ctrl} = setup(baseMessage({systemMessageVariant: 42}));
        ctrl.expectOne(PROFILE_URL).flush({userId: 'user_1', userName: 'Ada'});
        expect(component.variantKey()).toBe('MESSAGE.SYSTEM.GUILD_MEMBER_JOIN.0');
    });
});

describe('SystemMessageComponent rendering', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('renders the joining user as a mention chip inside the translated sentence', () => {
        const {fixture, ctrl} = setup(baseMessage({systemMessageVariant: 0}));
        ctrl.expectOne(PROFILE_URL).flush({userId: 'user_1', userName: 'Ada'});
        fixture.detectChanges();

        const host: HTMLElement = fixture.nativeElement;
        const chip = host.querySelector('.mention-chip')!;
        expect(chip.textContent).toBe('Ada');
        expect(host.textContent).toContain('joined the server');
        expect(host.textContent).not.toContain('%USER%');
    });

    it('falls back to the raw userId when the profile has not resolved yet', () => {
        const {fixture, ctrl} = setup(baseMessage({systemMessageVariant: 0}));
        const req = ctrl.expectOne(PROFILE_URL);
        fixture.detectChanges();

        const chip = (fixture.nativeElement as HTMLElement).querySelector('.mention-chip')!;
        expect(chip.textContent).toBe('user_1');

        req.flush({userId: 'user_1', userName: 'Ada'});
    });
});
