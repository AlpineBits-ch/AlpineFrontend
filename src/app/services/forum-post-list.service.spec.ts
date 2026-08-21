import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';

import {ForumPostListService} from './forum-post-list.service';
import {ApiConfigService} from './api-config.service';
import {RealtimeConnectionService} from './realtime-connection.service';
import {FakeRealtimeConnection} from '../testing/fake-realtime-connection';
import {ForumStateService} from './forum-state.service';
import {ForumPost, ForumSortOrder} from '../dtos/response/forum.dto';

const base = 'https://api.test.example/api/v1/guild';

function postFixture(overrides: Partial<ForumPost> = {}): ForumPost {
    return {
        id: 'p1',
        guildId: 'g1',
        parentChannelId: 'f1',
        type: 'Thread',
        name: 'A post',
        createdAt: '2026-07-30T00:00:00Z',
        updatedAt: '2026-07-30T00:00:00Z',
        createdByUserId: 'u1',
        tagIds: [],
        isPinned: false,
        isLocked: false,
        isArchived: false,
        lastActivityAt: '2026-07-30T00:00:00Z',
        messageCount: 0,
        isAgeRestricted: false,
        isPrivate: false,
        slowModeSeconds: 0,
        ...overrides,
    };
}

/** Only the observables the service subscribes to; nothing else is touched. */
function wsStub() {
    return new FakeRealtimeConnection();
}

function setup() {
    const ws = wsStub();
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService({defaultLanguage: 'en'}),
            MessageService,
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            {provide: RealtimeConnectionService, useValue: ws},
            {provide: ForumStateService, useValue: {sortFor: () => ForumSortOrder.LatestActivity}},
        ],
    });
    return {
        service: TestBed.inject(ForumPostListService),
        ctrl: TestBed.inject(HttpTestingController),
        ws,
    };
}

/** The one in-flight posts request for a forum. */
function expectPosts(ctrl: HttpTestingController, forumId = 'f1') {
    return ctrl.expectOne(r => r.url === `${base}/channels/${forumId}/posts`);
}

/** Flushes the one in-flight posts request for a forum. */
function flushPosts(
    ctrl: HttpTestingController,
    posts: ForumPost[],
    nextCursor: string | null = null,
    forumId = 'f1',
) {
    const req = expectPosts(ctrl, forumId);
    req.flush({posts, nextCursor});
    return req;
}

const emptyState = {
    posts: [],
    loading: false,
    loadingMore: false,
    nextCursor: null,
    selectedTagIds: [],
    showArchived: false,
    hasLoaded: false,
    stale: false,
};

describe('ForumPostListService state', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    /** A read must never register a forum as opened - that would fetch behind the user's back. */
    it('returns an empty default state for a forum never loaded', () => {
        const {service} = setup();

        expect(service.stateFor('never-opened')).toEqual(emptyState);
    });

    it('keeps state isolated per forum id', () => {
        const {service, ctrl} = setup();

        service.reload('f1');
        service.reload('f2');
        flushPosts(ctrl, [postFixture({id: 'p1'})], null, 'f1');
        flushPosts(ctrl, [postFixture({id: 'p9', parentChannelId: 'f2'})], null, 'f2');

        expect(service.stateFor('f1').posts.map(p => p.id)).toEqual(['p1']);
        expect(service.stateFor('f2').posts.map(p => p.id)).toEqual(['p9']);
    });
});

describe('ForumPostListService loading', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    /** The cursor encodes the filters it was issued under, so a filter change starts over. */
    it('resets the cursor when a tag filter changes', () => {
        const {service, ctrl} = setup();

        service.reload('f1');
        flushPosts(ctrl, [postFixture({id: 'p1'})], 'c1');
        expect(service.stateFor('f1').nextCursor).toBe('c1');

        service.toggleTagFilter('f1', 'tag1');

        const req = expectPosts(ctrl);
        expect(req.request.params.has('cursor')).toBe(false);
        expect(req.request.params.get('tagIds')).toBe('tag1');
        req.flush({posts: [], nextCursor: null});
    });

    it('de-dupes by id when a loadMore response overlaps', () => {
        const {service, ctrl} = setup();

        service.reload('f1');
        flushPosts(ctrl, [postFixture({id: 'p1'}), postFixture({id: 'p2'})], 'c1');

        service.loadMore('f1');
        const req = expectPosts(ctrl);
        expect(req.request.params.get('cursor')).toBe('c1');
        req.flush({posts: [postFixture({id: 'p2'}), postFixture({id: 'p3'})], nextCursor: null});

        expect(service.stateFor('f1').posts.map(p => p.id)).toEqual(['p1', 'p2', 'p3']);
        expect(service.stateFor('f1').loadingMore).toBe(false);
    });

    /**
     * posts: [] can't tell "not fetched yet" from "this forum is empty", and a pane that
     * mounts before its first response would paint the empty state instead of a spinner.
     */
    it('reports hasLoaded only once a fetch has actually succeeded', () => {
        const {service, ctrl} = setup();

        expect(service.stateFor('never-opened').hasLoaded).toBe(false);

        service.reload('f1');
        expect(service.stateFor('f1').hasLoaded).toBe(false);

        expectPosts(ctrl).flush('nope', {status: 500, statusText: 'Server Error'});
        expect(service.stateFor('f1').hasLoaded).toBe(false);

        service.reload('f1');
        flushPosts(ctrl, []);
        expect(service.stateFor('f1').hasLoaded).toBe(true);
        expect(service.stateFor('f1').posts).toEqual([]);
    });

    /**
     * A reload abandons the append in flight, whose response is then dropped as stale - so
     * reload has to clear loadingMore itself, or nothing ever will and loadMore's own guard
     * blocks infinite scroll for the rest of the session.
     */
    it('keeps infinite scroll alive when a reload interrupts a loadMore', () => {
        const {service, ctrl} = setup();

        service.reload('f1');
        flushPosts(ctrl, [postFixture({id: 'p1'})], 'c1');

        service.loadMore('f1');
        service.reload('f1');
        const requests = ctrl.match(r => r.url === `${base}/channels/f1/posts`);
        expect(requests.length).toBe(2);

        requests[1].flush({posts: [postFixture({id: 'p1'})], nextCursor: 'c2'});
        // The abandoned append lands late; it is dropped, so it can't clear the flag either.
        requests[0].flush({posts: [postFixture({id: 'pX'})], nextCursor: 'c9'});

        expect(service.stateFor('f1').loadingMore).toBe(false);
        expect(service.stateFor('f1').posts.map(p => p.id)).toEqual(['p1']);

        service.loadMore('f1');
        const more = expectPosts(ctrl);
        expect(more.request.params.get('cursor')).toBe('c2');
        more.flush({posts: [postFixture({id: 'p3'})], nextCursor: null});

        expect(service.stateFor('f1').posts.map(p => p.id)).toEqual(['p1', 'p3']);
    });

    /**
     * A response for a list the user has since reloaded must not overwrite the one they're
     * now looking at, so the older request is flushed last and has to lose.
     */
    it('does not apply a stale response to a forum that has since reloaded', () => {
        const {service, ctrl} = setup();

        service.reload('f1');
        service.reload('f1');
        const requests = ctrl.match(r => r.url === `${base}/channels/f1/posts`);
        expect(requests.length).toBe(2);

        requests[1].flush({posts: [postFixture({id: 'p2'})], nextCursor: null});
        requests[0].flush({posts: [postFixture({id: 'p1'})], nextCursor: null});

        expect(service.stateFor('f1').posts.map(p => p.id)).toEqual(['p2']);
        expect(service.stateFor('f1').loading).toBe(false);
    });
});

describe('ForumPostListService realtime', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    /**
     * Inventing a partial entry for an unopened forum would make "has this forum been
     * opened?" untrue - the first reload fetches the authoritative list instead.
     */
    it('ignores a threadUpdated event for a forum with no loaded state', () => {
        const {service, ws} = setup();

        ws.emit('guild.ThreadUpdated', {
            guildId: 'g1',
            parentChannelId: 'never-opened',
            channelId: 'x',
            isPinned: true,
        });

        expect(service.stateFor('never-opened')).toEqual(emptyState);

        // The default state is indistinguishable from a conjured empty entry by value, so
        // ask the service whether it thinks the forum is open: a created post in an open
        // forum triggers a reload, and afterEach's verify() would fail on that request.
        ws.emit('guild.ThreadCreated', {guildId: 'g1', parentChannelId: 'never-opened', channelId: 'x'});
    });

    /**
     * The state outlives the components reading it, so a created post must not make every
     * forum opened this session refetch - only the one the user is actually looking at.
     */
    it('reloads the active forum on a created post and only marks the others stale', () => {
        const {service, ctrl, ws} = setup();

        service.reload('f1');
        flushPosts(ctrl, [postFixture({id: 'p1'})], null, 'f1');
        service.reload('f2');
        flushPosts(ctrl, [postFixture({id: 'p9', parentChannelId: 'f2'})], null, 'f2');

        service.setActiveForum('f1');

        ws.emit('guild.ThreadCreated', {guildId: 'g1', parentChannelId: 'f1', channelId: 'new1'});
        flushPosts(ctrl, [postFixture({id: 'p1'}), postFixture({id: 'new1'})], null, 'f1');
        expect(service.stateFor('f1').posts.map(p => p.id)).toEqual(['p1', 'new1']);
        expect(service.stateFor('f1').stale).toBe(false);

        ws.emit('guild.ThreadCreated', {guildId: 'g1', parentChannelId: 'f2', channelId: 'new2'});
        expect(service.stateFor('f2').stale).toBe(true);
        expect(service.stateFor('f2').posts.map(p => p.id)).toEqual(['p9']);

        // Catching up is the mounting component's job, and only costs a request once.
        service.reloadIfStale('f2');
        flushPosts(
            ctrl,
            [postFixture({id: 'p9', parentChannelId: 'f2'}), postFixture({id: 'new2'})],
            null,
            'f2',
        );
        expect(service.stateFor('f2').posts.map(p => p.id)).toEqual(['p9', 'new2']);
        expect(service.stateFor('f2').stale).toBe(false);

        service.reloadIfStale('f2');
    });

    /**
     * Opening a post destroys the full-width list and creates the pane over the same forum.
     * Angular doesn't promise the destroy runs first, and both claims name the same forum,
     * so a release has to be identified by its token - otherwise the late destroy revokes
     * the pane's claim and created posts silently stop appearing in it.
     */
    it('keeps the forum live when the outgoing mount point is destroyed after the incoming one', () => {
        const {service, ctrl, ws} = setup();

        service.reload('f1');
        flushPosts(ctrl, [postFixture({id: 'p1'})]);

        const list = service.setActiveForum('f1');
        const pane = service.setActiveForum('f1');
        service.releaseActiveForum(list);

        ws.emit('guild.ThreadCreated', {guildId: 'g1', parentChannelId: 'f1', channelId: 'new1'});
        flushPosts(ctrl, [postFixture({id: 'p1'}), postFixture({id: 'new1'})]);
        expect(service.stateFor('f1').posts.map(p => p.id)).toEqual(['p1', 'new1']);

        // The live claim still releases normally, leaving nothing on screen to keep current.
        service.releaseActiveForum(pane);
        ws.emit('guild.ThreadCreated', {guildId: 'g1', parentChannelId: 'f1', channelId: 'new2'});
        expect(service.stateFor('f1').stale).toBe(true);
    });

    it('drops an archived post when showArchived is false', () => {
        const {service, ctrl, ws} = setup();

        service.reload('f1');
        flushPosts(ctrl, [postFixture({id: 'p1'})]);

        ws.emit('guild.ThreadUpdated', {
            guildId: 'g1',
            parentChannelId: 'f1',
            channelId: 'p1',
            isArchived: true,
        });

        expect(service.stateFor('f1').posts).toEqual([]);
    });

    it('keeps an archived post when showArchived is true', () => {
        const {service, ctrl, ws} = setup();

        service.reload('f1');
        flushPosts(ctrl, [postFixture({id: 'p1'})]);

        service.toggleArchived('f1');
        const req = expectPosts(ctrl);
        expect(req.request.params.get('archived')).toBe('all');
        req.flush({posts: [postFixture({id: 'p1'})], nextCursor: null});

        ws.emit('guild.ThreadUpdated', {
            guildId: 'g1',
            parentChannelId: 'f1',
            channelId: 'p1',
            isArchived: true,
        });

        expect(service.stateFor('f1').posts.map(p => p.id)).toEqual(['p1']);
        expect(service.stateFor('f1').posts[0].isArchived).toBe(true);
    });
});
