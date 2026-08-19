/**
 * A scene is thread-shaped and shares its parent with the threads beside it, so it reaches
 * `openThread` from the sidebar and from a card. It must not end up in the side panel.
 */
import {TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';

import {NavigationService} from './navigation.service';
import {AccountRegistryService} from '../../services/account-registry.service';
import {ChannelDto, ChannelType} from '../../dtos/response/guild.dto';

function channelFixture(overrides: Partial<ChannelDto> & {id: string}): ChannelDto {
    return {
        createdAt: new Date('2026-08-19T00:00:00Z'),
        updatedAt: new Date('2026-08-19T00:00:00Z'),
        name: overrides.id,
        description: '',
        type: ChannelType.Thread,
        guildId: 'g1',
        isAgeRestricted: false,
        isPrivate: false,
        categoryId: undefined,
        permissions: [],
        position: 0,
        slowModeSeconds: 0,
        parentChannelId: 'chan_text',
        ...overrides,
    } as ChannelDto;
}

function setup() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [{provide: AccountRegistryService, useValue: {activeSlotIdSnapshot: () => 'slot1'}}],
    });
    return TestBed.inject(NavigationService);
}

describe('NavigationService thread panel', () => {
    it('opens an ordinary thread in the side panel', () => {
        const nav = setup();

        nav.openThread(channelFixture({id: 'chan_thread'}));

        expect(nav.threadPanel()?.id).toBe('chan_thread');
        expect(nav.mainView().type).not.toBe('channel');
    });

    it('opens a scene in the main view instead, leaving the panel shut', () => {
        const nav = setup();

        nav.openThread(channelFixture({id: 'chan_scene', type: ChannelType.Scene}));

        expect(nav.threadPanel()).toBeNull();
        const view = nav.mainView();
        expect(view.type).toBe('channel');
        expect(view.type === 'channel' && view.channel.id).toBe('chan_scene');
    });

    it('opens the out-of-character room in the panel, since it is an ordinary thread', () => {
        const nav = setup();

        nav.openThread(channelFixture({id: 'chan_ooc', name: 'A scene (OOC)'}));

        expect(nav.threadPanel()?.id).toBe('chan_ooc');
    });

    it('closes the panel when the main view moves', () => {
        const nav = setup();
        nav.openThread(channelFixture({id: 'chan_thread'}));

        nav.openChannel(channelFixture({id: 'chan_other', type: ChannelType.Text}));
        TestBed.tick();

        expect(nav.threadPanel()).toBeNull();
    });
});
