import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService, TranslateService} from '@ngx-translate/core';
import {beforeEach, describe, expect, it} from 'vitest';
import {formatDuration, SystemMessageComponent} from './system-message.component';
import {ApiConfigService} from '../../../../../../services/api-config.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {MessageDto} from '../../../../../../dtos/response/message.dto';
import {MessageType} from '../../../../../../enums/message-type.enum';
import {MessageEncryptionState} from '../../../../../../enums/message-encryption-state.enum';

const BASE = 'https://api.test.example';
const CALLER = 'user_caller';
const PROFILE_URL = `${BASE}/api/v1/social/profiles/by-user/${CALLER}`;

/** The server writes the duration as whole seconds of plain text, and `content` is base64. */
function encode(text: string): string {
    return btoa(text);
}

function callMessage(type: MessageType, content = ''): MessageDto {
    return {
        id: 'mesg_1',
        createdAt: new Date(),
        updatedAt: new Date(),
        content,
        channelId: undefined,
        conversationId: 'conv_1',
        authorId: CALLER,
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
    } as MessageDto;
}

function setup(message: MessageDto, ownUserId?: string) {
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
        'MESSAGE.SYSTEM.CALL_ENDED': '%USER% started a call · {{duration}}',
        'MESSAGE.SYSTEM.CALL_ENDED_NO_DURATION': '%USER% started a call',
        'MESSAGE.SYSTEM.CALL_MISSED': 'You missed a call from %USER%',
        'MESSAGE.SYSTEM.CALL_MISSED_OWN': '%USER% called, but nobody answered',
    });

    if (ownUserId) {
        TestBed.inject(ProfileService).ownProfile.set({userId: ownUserId, userName: 'Me'} as never);
    }

    const fixture: ComponentFixture<SystemMessageComponent> = TestBed.createComponent(SystemMessageComponent);
    fixture.componentRef.setInput('message', message);
    const ctrl = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    ctrl.expectOne(PROFILE_URL).flush({userId: CALLER, userName: 'Ada'});
    fixture.detectChanges();
    return {fixture, component: fixture.componentInstance, ctrl};
}

describe('SystemMessageComponent call notices', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('renders an answered call with its duration', () => {
        const {fixture} = setup(callMessage(MessageType.CallEnded, encode('184')));

        const host: HTMLElement = fixture.nativeElement;
        expect(host.textContent).toContain('started a call');
        expect(host.textContent).toContain('3m 4s');
        expect(host.querySelector('.mention-chip')!.textContent).toBe('Ada');
    });

    it('drops to duration-less copy rather than leaving a hole in the sentence', () => {
        // Content is empty on an entry written before the duration existed, or malformed. The
        // sentence still has to read as one.
        const {component, fixture} = setup(callMessage(MessageType.CallEnded));

        expect(component.variantKey()).toBe('MESSAGE.SYSTEM.CALL_ENDED_NO_DURATION');
        expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('·');
    });

    it('ignores a duration that is not a number', () => {
        const {component} = setup(callMessage(MessageType.CallEnded, encode('not-a-number')));

        expect(component.duration()).toBe('');
        expect(component.variantKey()).toBe('MESSAGE.SYSTEM.CALL_ENDED_NO_DURATION');
    });

    it('tells the recipient they missed the call', () => {
        const {fixture} = setup(callMessage(MessageType.CallMissed), 'user_other');

        expect((fixture.nativeElement as HTMLElement).textContent).toContain('You missed a call from');
    });

    it('does not tell the caller they missed their own call', () => {
        // The entry is authored by whoever placed the call, so the caller reads it too. "You missed
        // a call from yourself" is the sentence this branch exists to avoid.
        const {component, fixture} = setup(callMessage(MessageType.CallMissed), CALLER);

        expect(component.variantKey()).toBe('MESSAGE.SYSTEM.CALL_MISSED_OWN');
        expect((fixture.nativeElement as HTMLElement).textContent).toContain('nobody answered');
    });

    it('carries no duration on a missed call', () => {
        const {component} = setup(callMessage(MessageType.CallMissed), 'user_other');

        expect(component.duration()).toBe('');
    });
});

describe('formatDuration', () => {
    it('shows seconds alone under a minute', () => {
        expect(formatDuration(45)).toBe('45s');
    });

    it('shows minutes and seconds under an hour', () => {
        expect(formatDuration(184)).toBe('3m 4s');
    });

    it('drops seconds once there are hours, to keep it readable', () => {
        expect(formatDuration(3720)).toBe('1h 2m');
    });

    it('renders a zero-length call rather than an empty string', () => {
        expect(formatDuration(0)).toBe('0s');
    });
});
