import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {ConversationUtilsService} from './conversation-utils.service';
import {ApiConfigService} from './api-config.service';
import {signal} from '@angular/core';
import {ConversationDto} from '../dtos/response/conversation.dto';
import {ConversationEncryption} from '../enums/conversation-encryption.enum';
import {TypingService} from './typing.service';

const BASE = 'https://api.test.example';

function conversation(iconUpdatedAt: string | null | undefined): ConversationDto {
    return {
        id: 'conv_1',
        createdAt: new Date(),
        updatedAt: new Date(),
        name: 'Group',
        iconUpdatedAt,
        members: [],
        encryptionState: ConversationEncryption.Plain,
    };
}

function service(): ConversationUtilsService {
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
            // Stubbed because the real one reaches the realtime connection, which reaches OAuth.
            {provide: TypingService, useValue: {state: signal(new Map<string, Set<string>>())}},
        ],
    });
    return TestBed.inject(ConversationUtilsService);
}

describe('ConversationUtilsService.getChatIconUrl', () => {
    it('is null when the group has no icon', () => {
        const utils = service();

        expect(utils.getChatIconUrl(conversation(null))).toBeNull();
        expect(utils.getChatIconUrl(conversation(undefined))).toBeNull();
    });

    it('cache-busts on the icon timestamp, not on updatedAt', () => {
        const url = service().getChatIconUrl(conversation('2026-08-17T19:24:49Z'));

        expect(url).toBe(
            `${BASE}/api/v1/messaging/conversations/conv_1/icon?v=${encodeURIComponent('2026-08-17T19:24:49Z')}`,
        );
    });
});
