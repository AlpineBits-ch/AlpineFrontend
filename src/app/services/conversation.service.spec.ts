import {describe, expect, it} from 'vitest';
import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {ApiConfigService} from './api-config.service';
import {ConversationService, CreateConversationResult} from './conversation.service';
import {ConversationDto} from '../dtos/response/conversation.dto';
import {CreateConversationDto} from '../dtos/request/create-conversation.dto';
import {ConversationEncryption} from '../enums/conversation-encryption.enum';

const BASE = 'https://api.test.example';
const CREATE = `${BASE}/api/v1/messaging/conversations`;

const REQUEST: CreateConversationDto = {
    name: undefined,
    members: [{userId: 'user-2'}],
    encryption: ConversationEncryption.Plain,
    deviceWelcomes: [],
};

const CONVERSATION = {id: 'conv-1', members: []} as unknown as ConversationDto;

function setup() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
        ],
    });
    return {
        service: TestBed.inject(ConversationService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

describe('ConversationService.createConversation', () => {
    it('reports a created conversation as new', () => {
        const {service, ctrl} = setup();
        let result: CreateConversationResult | null = null;
        service.createConversation(REQUEST).subscribe(r => (result = r));

        ctrl.expectOne(CREATE).flush(CONVERSATION);

        expect(result).toEqual({conversation: CONVERSATION, existing: false});
        ctrl.verify();
    });

    it('turns the 302 body into the existing conversation', () => {
        const {service, ctrl} = setup();
        let result: CreateConversationResult | null = null;
        service.createConversation(REQUEST).subscribe(r => (result = r));

        ctrl.expectOne(CREATE).flush(CONVERSATION, {status: 302, statusText: 'Found'});

        expect(result).toEqual({conversation: CONVERSATION, existing: true});
        ctrl.verify();
    });

    it('parses a 302 body that arrived as text', () => {
        const {service, ctrl} = setup();
        let result: CreateConversationResult | null = null;
        service.createConversation(REQUEST).subscribe(r => (result = r));

        ctrl.expectOne(CREATE).flush(JSON.stringify(CONVERSATION), {status: 302, statusText: 'Found'});

        expect(result).toEqual({conversation: CONVERSATION, existing: true});
        ctrl.verify();
    });

    it('still fails when a 302 carries no conversation', () => {
        const {service, ctrl} = setup();
        let status: number | null = null;
        service.createConversation(REQUEST).subscribe({error: err => (status = err.status)});

        ctrl.expectOne(CREATE).flush('', {status: 302, statusText: 'Found'});

        expect(status).toBe(302);
        ctrl.verify();
    });

    it('leaves a refusal alone', () => {
        const {service, ctrl} = setup();
        let status: number | null = null;
        service.createConversation(REQUEST).subscribe({error: err => (status = err.status)});

        ctrl.expectOne(CREATE).flush({code: 'dm_blocked'}, {status: 403, statusText: 'Forbidden'});

        expect(status).toBe(403);
        ctrl.verify();
    });
});
