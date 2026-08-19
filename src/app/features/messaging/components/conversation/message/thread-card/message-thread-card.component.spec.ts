import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {describe, expect, it, vi} from 'vitest';

import {MessageThreadCardComponent} from './message-thread-card.component';
import {ThreadRegistryService} from '../../../../../../services/thread-registry.service';
import {NavigationService} from '../../../../../main-page/navigation.service';
import {ChannelDto, ChannelType} from '../../../../../../dtos/response/guild.dto';

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
        messageCount: 3,
        ...overrides,
    };
}

async function setup(thread: ChannelDto | null) {
    TestBed.resetTestingModule();
    const registry = {thread: vi.fn(() => thread), ensureThread: vi.fn()};
    const nav = {openThread: vi.fn()};

    await TestBed.configureTestingModule({
        imports: [MessageThreadCardComponent],
        providers: [
            provideTranslateService({defaultLanguage: 'en'}),
            {provide: ThreadRegistryService, useValue: registry},
            {provide: NavigationService, useValue: nav},
        ],
    }).compileComponents();

    const fixture: ComponentFixture<MessageThreadCardComponent> =
        TestBed.createComponent(MessageThreadCardComponent);
    fixture.componentRef.setInput('threadId', 'chan_thread');
    fixture.detectChanges();
    return {fixture, registry, nav};
}

describe('MessageThreadCardComponent', () => {
    it('renders the thread name when the registry resolves it', async () => {
        const {fixture} = await setup(threadFixture());

        expect(fixture.nativeElement.textContent).toContain('about that message');
    });

    it('renders nothing for a threadId that resolves to nothing', async () => {
        const {fixture} = await setup(null);

        expect(fixture.nativeElement.textContent.trim()).toBe('');
    });

    it('asks the registry to resolve the id it was given', async () => {
        const {registry} = await setup(null);

        expect(registry.ensureThread).toHaveBeenCalledWith('chan_thread');
    });

    it('opens the panel when clicked', async () => {
        const {fixture, nav} = await setup(threadFixture());

        fixture.nativeElement.querySelector('button').click();

        expect(nav.openThread).toHaveBeenCalledOnce();
    });

    it('uses the singular count key for one message', async () => {
        const {fixture} = await setup(threadFixture({messageCount: 1}));

        expect(fixture.nativeElement.textContent).toContain('THREAD.MESSAGE_COUNT_ONE');
    });

    it('uses the plural count key for anything else', async () => {
        const {fixture} = await setup(threadFixture({messageCount: 12}));

        expect(fixture.nativeElement.textContent).toContain('THREAD.MESSAGE_COUNT');
    });
});
