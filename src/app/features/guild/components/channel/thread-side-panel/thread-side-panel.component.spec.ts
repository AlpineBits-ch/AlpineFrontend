import {ComponentFixture, TestBed} from '@angular/core/testing';
import {CUSTOM_ELEMENTS_SCHEMA, signal} from '@angular/core';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {provideFakePlatform} from '../../../../../platform/testing/provide-fake-platform';
import {MessageService} from 'primeng/api';
import {of} from 'rxjs';
import {describe, expect, it, vi} from 'vitest';

import {ThreadSidePanelComponent} from './thread-side-panel.component';
import {ChannelConversationComponent} from '../channel-conversation/channel-conversation.component';
import {MessagingService} from '../../../../../services/messaging.service';
import {ApiConfigService} from '../../../../../services/api-config.service';
import {MessageStore} from '../../../../../stores/message.store';
import {NavigationService} from '../../../../main-page/navigation.service';
import {ChannelDto, ChannelType} from '../../../../../dtos/response/guild.dto';
import {MessageDto} from '../../../../../dtos/response/message.dto';
import {MessageType} from '../../../../../enums/message-type.enum';
import {MessageEncryptionState} from '../../../../../enums/message-encryption-state.enum';

function threadFixture(overrides: Partial<ChannelDto> = {}): ChannelDto {
    return {
        id: 'chan_thread',
        createdAt: new Date('2026-08-19T00:00:00Z'),
        updatedAt: new Date('2026-08-19T00:00:00Z'),
        name: 'about that message',
        description: '',
        type: ChannelType.Thread,
        guildId: 'g1',
        isAgeRestricted: false,
        isPrivate: false,
        categoryId: undefined,
        permissions: [],
        position: 0,
        slowModeSeconds: 0,
        parentChannelId: 'chan_parent',
        starterMessageId: 'mesg_starter',
        ...overrides,
    };
}

function starterFixture(): MessageDto {
    return {
        id: 'mesg_starter',
        createdAt: new Date('2026-08-19T00:00:00Z'),
        updatedAt: new Date('2026-08-19T00:00:00Z'),
        content: btoa('the deployment broke again'),
        channelId: 'chan_parent',
        conversationId: undefined,
        authorId: 'u1',
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
    };
}

async function setup(thread: ChannelDto, held: MessageDto[] = []) {
    TestBed.resetTestingModule();
    const messaging = {getMessageById: vi.fn(() => of(starterFixture()))};
    const guild = {id: 'g1', name: 'G', roles: [], channels: [{id: 'chan_parent', name: 'general'}]};

    await TestBed.configureTestingModule({
        imports: [ThreadSidePanelComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService({defaultLanguage: 'en'}),
            provideFakePlatform(),
            MessageService,
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            {provide: MessagingService, useValue: messaging},
            {provide: MessageStore, useValue: {entities: signal(held)}},
            {
                provide: NavigationService,
                useValue: {
                    workspace: signal({type: 'server' as const, guild}),
                    closeThread: vi.fn(),
                },
            },
        ],
    })
        // The conversation body is a whole channel view; this file is about the chrome around it.
        .overrideComponent(ThreadSidePanelComponent, {
            remove: {imports: [ChannelConversationComponent]},
            add: {schemas: [CUSTOM_ELEMENTS_SCHEMA]},
        })
        .compileComponents();

    const fixture: ComponentFixture<ThreadSidePanelComponent> =
        TestBed.createComponent(ThreadSidePanelComponent);
    fixture.componentRef.setInput('thread', thread);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    return {fixture, messaging};
}

describe('ThreadSidePanelComponent', () => {
    it('fetches the starter message when the store does not hold it', async () => {
        const {messaging} = await setup(threadFixture());

        expect(messaging.getMessageById).toHaveBeenCalledOnce();
        expect(messaging.getMessageById).toHaveBeenCalledWith({
            channelId: 'chan_parent',
            messageId: 'mesg_starter',
        });
    });

    it('does not fetch a starter message the store already holds', async () => {
        const {messaging} = await setup(threadFixture(), [starterFixture()]);

        expect(messaging.getMessageById).not.toHaveBeenCalled();
    });

    it('renders the starter quote once it is resolved', async () => {
        const {fixture} = await setup(threadFixture(), [starterFixture()]);

        expect(fixture.nativeElement.textContent).toContain('the deployment broke again');
    });

    it('asks for nothing when the thread has no starter', async () => {
        const {messaging} = await setup(threadFixture({starterMessageId: undefined}));

        expect(messaging.getMessageById).not.toHaveBeenCalled();
    });

    it('shows the archived notice on an archived thread', async () => {
        const {fixture} = await setup(threadFixture({isArchived: true}));

        expect(fixture.nativeElement.textContent).toContain('THREAD.ARCHIVED_NOTICE');
    });

    it('does not show the archived notice on a live thread', async () => {
        const {fixture} = await setup(threadFixture());

        expect(fixture.nativeElement.textContent).not.toContain('THREAD.ARCHIVED_NOTICE');
    });
});
