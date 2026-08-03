import {TestBed} from '@angular/core/testing';

import {NavigationService} from './navigation.service';
import {ChannelDto, ChannelType, GuildDto} from '../../dtos/response/guild.dto';
import {ConversationDto} from '../../dtos/response/conversation.dto';

/**
 * The service persists every navigation, and this runner's global localStorage has no methods,
 * so without a stand-in every `saveNav` throws past the history push that precedes it.
 */
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

function chan(id: string, type: ChannelType = ChannelType.Text): ChannelDto {
    return {
        id,
        createdAt: new Date(),
        updatedAt: new Date(),
        name: id,
        description: '',
        type,
        guildId: 'g1',
        isAgeRestricted: false,
        isPrivate: false,
        categoryId: undefined,
        permissions: [],
        position: 0,
        slowModeSeconds: 0,
        parentChannelId: undefined,
    } as ChannelDto;
}

const general = chan('general');
const random = chan('random');
const guild = {id: 'g1', name: 'Guild One', channels: [general, random], categories: []} as unknown as GuildDto;
const conversation = {id: 'c1', name: 'Chat', members: []} as unknown as ConversationDto;

function setup(): NavigationService {
    store.clear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    return TestBed.inject(NavigationService);
}

describe('NavigationService history', () => {
    it('starts with nowhere to go', () => {
        const nav = setup();
        expect(nav.canGoBack()).toBe(false);
        expect(nav.canGoForward()).toBe(false);
    });

    it('steps back to the previously opened place', () => {
        const nav = setup();
        nav.selectServer(guild);
        nav.openChannel(random);

        expect(nav.canGoBack()).toBe(true);
        nav.back();

        const view = nav.mainView();
        expect(view.type).toBe('channel');
        expect(view.type === 'channel' && view.channel.id).toBe('general');
        expect(nav.canGoForward()).toBe(true);
    });

    it('steps forward again after going back', () => {
        const nav = setup();
        nav.selectServer(guild);
        nav.openChannel(random);
        nav.back();
        nav.forward();

        const view = nav.mainView();
        expect(view.type === 'channel' && view.channel.id).toBe('random');
        expect(nav.canGoForward()).toBe(false);
    });

    it('restores the workspace the entry belonged to, not just the view', () => {
        const nav = setup();
        nav.selectServer(guild);
        nav.openChannel(random);
        nav.openConversation(conversation);

        expect(nav.workspace().type).toBe('dms');
        nav.back();

        const workspace = nav.workspace();
        expect(workspace.type).toBe('server');
        expect(workspace.type === 'server' && workspace.guild.id).toBe('g1');
    });

    it('does not record reopening the place it is already on', () => {
        const nav = setup();
        nav.selectServer(guild);
        nav.openChannel(random);
        nav.openChannel(random);
        nav.openChannel(random);

        nav.back();
        const view = nav.mainView();
        expect(view.type === 'channel' && view.channel.id).toBe('general');
    });

    it('abandons the forward tail once a new place is opened', () => {
        const nav = setup();
        nav.selectServer(guild);
        nav.openChannel(random);
        nav.back();
        expect(nav.canGoForward()).toBe(true);

        nav.openConversation(conversation);
        expect(nav.canGoForward()).toBe(false);
    });

    it('moves the wiki side panel with the entry it steps onto', () => {
        const nav = setup();
        nav.selectServer(guild);
        nav.openWiki('g1');
        nav.openChannel(random);
        expect(nav.wikiPanelGuildId()).toBe('g1');

        nav.back();
        expect(nav.mainView().type).toBe('wiki');
        expect(nav.wikiPanelGuildId()).toBe('g1');

        nav.forward();
        expect(nav.wikiPanelGuildId()).toBeNull();
    });

    it('stops at the ends rather than falling off them', () => {
        const nav = setup();
        nav.selectServer(guild);

        nav.back();
        nav.back();
        nav.back();
        expect(nav.canGoBack()).toBe(false);
        expect(nav.mainView().type).toBe('home');

        nav.forward();
        nav.forward();
        expect(nav.canGoForward()).toBe(false);
    });
});
