import {TestBed} from '@angular/core/testing';

import {NavigationService} from './navigation.service';
import {ChannelDto, ChannelType, GuildDto} from '../../dtos/response/guild.dto';
import {ConversationDto} from '../../dtos/response/conversation.dto';
import {provideFakePlatform} from '../../platform/testing/provide-fake-platform';
import {
    clearGuildLayoutCache,
    readGuildLayoutCache,
    writeGuildLayoutCache,
} from '../../services/guild-layout-cache';

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
const guild = {
    id: 'g1',
    name: 'Guild One',
    channels: [general, random],
    categories: [],
    roles: [],
} as unknown as GuildDto;
const conversation = {id: 'c1', name: 'Chat', members: []} as unknown as ConversationDto;

function setup(): NavigationService {
    store.clear();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({providers: [provideFakePlatform()]});
    return TestBed.inject(NavigationService);
}

/** A second launch against the same storage: everything on disk survives, the service does not. */
function relaunch(): NavigationService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({providers: [provideFakePlatform()]});
    return TestBed.inject(NavigationService);
}

describe('NavigationService restoring from the cached layout', () => {
    /**
     * The cold-start path end to end. `GuildService` hydrates itself from the layout on disk before
     * it issues a request, and the rail hands that list straight to here - so this has to succeed
     * against a list that came out of `localStorage` rather than off the wire, or the first paint
     * still waits for the network.
     */
    it('restores the last channel from a list read back out of the cache', () => {
        const nav = setup();
        nav.selectServer(guild);
        nav.openChannel(random);
        writeGuildLayoutCache([guild]);

        const cold = relaunch();
        expect(cold.tryRestoreGuildNav(readGuildLayoutCache())).toBe(true);

        const view = cold.mainView();
        expect(view.type === 'channel' && view.channel.id).toBe('random');
        expect(cold.workspace().type).toBe('server');
    });

    it('restores against the revived list, whose dates are Dates rather than strings', () => {
        const nav = setup();
        nav.selectServer(guild);
        nav.openChannel(random);
        writeGuildLayoutCache([guild]);

        const restored = readGuildLayoutCache();
        expect(restored[0].channels[0].createdAt).toBeInstanceOf(Date);
        expect(relaunch().tryRestoreGuildNav(restored)).toBe(true);
    });

    it('reports failure when the cache holds nothing, leaving the caller to wait for the network', () => {
        const nav = setup();
        nav.selectServer(guild);
        clearGuildLayoutCache();

        expect(relaunch().tryRestoreGuildNav(readGuildLayoutCache())).toBe(false);
    });

    /** A guild left on another device is in the cache and not in the response. */
    it('reports failure when the list no longer contains the guild it points at', () => {
        const nav = setup();
        nav.selectServer(guild);
        nav.openChannel(random);

        expect(relaunch().tryRestoreGuildNav([])).toBe(false);
    });
});

describe('NavigationService.updateCurrentGuild', () => {
    /**
     * The identity guard. `workspace` feeds the member list, the channel list and the channel view,
     * and all three read a new reference as "different guild, start over". The websocket
     * `guildUpdated` handler calls this on every event it receives.
     */
    it('does nothing at all when handed the object it already holds', () => {
        const nav = setup();
        nav.selectServer(guild);
        const before = nav.workspace();

        nav.updateCurrentGuild(guild);

        expect(nav.workspace()).toBe(before);
    });

    it('re-points the workspace at a genuinely newer object', () => {
        const nav = setup();
        nav.selectServer(guild);
        const renamed = {...guild, name: 'Guild One Renamed'} as GuildDto;

        nav.updateCurrentGuild(renamed);

        const ws = nav.workspace();
        expect(ws.type === 'server' && ws.guild.name).toBe('Guild One Renamed');
    });

    it('ignores a guild that is not the one on screen', () => {
        const nav = setup();
        nav.selectServer(guild);
        const before = nav.workspace();

        nav.updateCurrentGuild({...guild, id: 'other'} as GuildDto);

        expect(nav.workspace()).toBe(before);
    });

    /**
     * The channel in `mainView` came out of the previous guild object, so a rename would otherwise
     * keep showing the old name until the user clicked elsewhere - which is exactly what a warm
     * start would look like when the cached snapshot is out of date.
     */
    it('re-points the open channel when that channel changed', () => {
        const nav = setup();
        nav.selectServer(guild);
        nav.openChannel(general);

        const renamedChannel = {...general, name: 'announcements'} as ChannelDto;
        nav.updateCurrentGuild({...guild, channels: [renamedChannel, random]} as GuildDto);

        const view = nav.mainView();
        expect(view.type === 'channel' && view.channel.name).toBe('announcements');
    });

    it('leaves the open channel alone when only some other channel changed', () => {
        const nav = setup();
        nav.selectServer(guild);
        nav.openChannel(general);
        const before = nav.mainView();

        nav.updateCurrentGuild({...guild, name: 'Renamed'} as GuildDto);

        expect(nav.mainView()).toBe(before);
    });
});

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

    it('steps on and off the wiki through history', () => {
        const nav = setup();
        nav.selectServer(guild);
        nav.openWiki('g1');
        nav.openChannel(random);
        expect(nav.mainView().type).toBe('channel');

        nav.back();
        expect(nav.mainView()).toEqual({type: 'wiki', guildId: 'g1'});

        nav.forward();
        expect(nav.mainView().type).toBe('channel');
    });

    // The wiki used to own a side panel in the events panel's layout slot and had to close it.
    // It now lays out its own tree internally, so both can be on screen at once.
    it('leaves the events panel open when the wiki is opened', () => {
        const nav = setup();
        nav.selectServer(guild);
        nav.toggleEventsPanel('g1');
        nav.openWiki('g1');
        expect(nav.eventsPanelGuildId()).toBe('g1');
    });

    it('steps back into a channel when the wiki module is switched off underneath it', () => {
        const nav = setup();
        nav.selectServer(guild);
        nav.openWiki('g1');
        nav.leaveWiki();
        expect(nav.mainView().type).not.toBe('wiki');
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
