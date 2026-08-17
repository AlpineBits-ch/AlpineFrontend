import {TestBed} from '@angular/core/testing';

import {ForumVisitedPostsService, VISITED_POSTS_PER_FORUM} from './forum-visited-posts.service';
import {NavigationService} from '../features/main-page/navigation.service';
import {ChannelDto, ChannelType, GuildDto} from '../dtos/response/guild.dto';
import {provideFakePlatform} from '../platform/testing/provide-fake-platform';

const STORAGE_KEY = 'alpine.forum.visitedPosts';

/** This runner's global localStorage has no methods, so the service's own try/catch swallows every read and persistence could never be asserted without this stand-in. */
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

function chan(over: Partial<ChannelDto> & {id: string; type: ChannelType}): ChannelDto {
    return {
        createdAt: new Date(),
        updatedAt: new Date(),
        name: over.id,
        description: '',
        guildId: 'g1',
        isAgeRestricted: false,
        isPrivate: false,
        categoryId: undefined,
        permissions: [],
        position: 0,
        slowModeSeconds: 0,
        parentChannelId: undefined,
        ...over,
    } as ChannelDto;
}

const forum = chan({id: 'f1', type: ChannelType.Forum});
const textChannel = chan({id: 't1', type: ChannelType.Text});
const posts = Array.from({length: 8}, (_, i) =>
    chan({id: `p${i}`, type: ChannelType.Thread, parentChannelId: 'f1'}));

function setup() {
    TestBed.configureTestingModule({providers: [provideFakePlatform()]});
    const nav = TestBed.inject(NavigationService);
    nav.workspace.set({
        type: 'server',
        guild: {id: 'g1', channels: [forum, textChannel, ...posts], categories: []} as unknown as GuildDto,
    });
    return {nav, service: TestBed.inject(ForumVisitedPostsService)};
}

/** Drives the service the only way the app does: by opening something in the main view. */
function open(nav: NavigationService, channel: ChannelDto) {
    nav.mainView.set({type: 'channel', channel});
    TestBed.tick();
}

describe('ForumVisitedPostsService', () => {
    beforeEach(() => {
        localStorage.removeItem(STORAGE_KEY);
        TestBed.resetTestingModule();
    });

    afterEach(() => localStorage.removeItem(STORAGE_KEY));

    it('reports nothing for a forum whose posts have never been opened', () => {
        const {service} = setup();

        expect(service.postsFor('f1')).toEqual([]);
    });

    it('records a post once it is open in the main view', () => {
        const {nav, service} = setup();

        open(nav, posts[0]);

        expect(service.postsFor('f1')).toEqual(['p0']);
    });

    /** The effect fires on every main-view change, so it has to tell a forum post from everything else the user opens. */
    it('ignores a channel that is not a forum post', () => {
        const {nav, service} = setup();

        open(nav, textChannel);
        open(nav, forum);

        expect(service.postsFor('f1')).toEqual([]);
    });

    it('keeps the most recently opened first', () => {
        const {nav, service} = setup();

        open(nav, posts[0]);
        open(nav, posts[1]);
        open(nav, posts[2]);

        expect(service.postsFor('f1')).toEqual(['p2', 'p1', 'p0']);
    });

    it('moves a re-opened post back to the front rather than duplicating it', () => {
        const {nav, service} = setup();

        open(nav, posts[0]);
        open(nav, posts[1]);
        open(nav, posts[0]);

        expect(service.postsFor('f1')).toEqual(['p0', 'p1']);
    });

    it('evicts the oldest past the cap', () => {
        const {nav, service} = setup();

        for (const p of posts) open(nav, p);

        const kept = service.postsFor('f1');
        expect(kept.length).toBe(VISITED_POSTS_PER_FORUM);
        expect(kept[0]).toBe('p7');
        expect(kept).not.toContain('p0');
    });

    it('survives a reload', () => {
        const first = setup();
        open(first.nav, posts[3]);
        open(first.nav, posts[4]);

        TestBed.resetTestingModule();
        const second = setup();

        expect(second.service.postsFor('f1')).toEqual(['p4', 'p3']);
    });

    /** Losing these rows is cosmetic; taking the sidebar down over a bad string is not. */
    it('reads unparseable storage as nothing visited', () => {
        localStorage.setItem(STORAGE_KEY, '{not json');

        const {service} = setup();

        expect(service.postsFor('f1')).toEqual([]);
    });

    it('discards malformed entries without losing the well-formed ones', () => {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            f1: ['good1', 42, 'good2', null],
            f2: 'not-an-array',
            f3: ['other'],
        }));

        const {service} = setup();

        expect(service.postsFor('f1')).toEqual(['good1', 'good2']);
        expect(service.postsFor('f2')).toEqual([]);
        expect(service.postsFor('f3')).toEqual(['other']);
    });
});
