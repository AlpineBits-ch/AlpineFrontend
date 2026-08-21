import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';

import {ForumStateService} from './forum-state.service';
import {ApiConfigService} from './api-config.service';
import {RealtimeConnectionService} from './realtime-connection.service';
import {FakeRealtimeConnection} from '../testing/fake-realtime-connection';
import {ForumLayout, ForumSortOrder, ForumTag} from '../dtos/response/forum.dto';

const base = 'https://api.test.example/api/v1/guild';

function tagFixture(overrides: Partial<ForumTag> = {}): ForumTag {
    return {
        id: 'ftag_1',
        channelId: 'f1',
        guildId: 'g1',
        name: 'bug',
        color: '#e74c3c',
        position: 0,
        moderated: false,
        postCount: 0,
        ...overrides,
    };
}

/** Only the observables ForumStateService subscribes to; nothing else is touched. */
function wsStub() {
    return new FakeRealtimeConnection();
}

function setup() {
    const ws = wsStub();
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            {provide: RealtimeConnectionService, useValue: ws},
        ],
    });
    const service = TestBed.inject(ForumStateService);
    const http = TestBed.inject(HttpTestingController);
    return {service, http, ws};
}

/** loadFor issues both reads; the config one is flushed empty unless a test needs it. */
function flushLoad(http: HttpTestingController, tags: ForumTag[] = [], config: object = {}) {
    http.expectOne(`${base}/channels/f1/tags`).flush(tags);
    http.expectOne(`${base}/channels/f1/forum-config`).flush(config);
}

describe('ForumStateService loading', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('fetches tags and config once per forum', () => {
        const {service, http} = setup();

        service.loadFor('f1');
        flushLoad(http, [tagFixture()]);

        service.loadFor('f1');
        http.expectNone(`${base}/channels/f1/tags`);
        expect(service.tagsFor('f1').length).toBe(1);
    });

    it('orders tags by position, breaking ties by name', () => {
        const {service, http} = setup();

        service.loadFor('f1');
        flushLoad(http, [
            tagFixture({id: 'b', name: 'zebra', position: 1}),
            tagFixture({id: 'c', name: 'apple', position: 1}),
            tagFixture({id: 'a', name: 'first', position: 0}),
        ]);

        expect(service.tagsFor('f1').map(t => t.id)).toEqual(['a', 'c', 'b']);
    });

    /** An empty filter bar is a degraded but working forum; a hard failure would block reading. */
    it('falls back to an empty tag list when the fetch fails', () => {
        const {service, http} = setup();

        service.loadFor('f1');
        http.expectOne(`${base}/channels/f1/tags`).flush('nope', {status: 500, statusText: 'Server Error'});
        http.expectOne(`${base}/channels/f1/forum-config`).flush({});

        expect(service.tagsFor('f1')).toEqual([]);
    });
});

describe('ForumStateService realtime', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('adds a created tag in position order', () => {
        const {service, http, ws} = setup();
        service.loadFor('f1');
        flushLoad(http, [tagFixture({id: 'a', position: 0})]);

        ws.emit('guild.ForumTagCreated', {
            guildId: 'g1',
            channelId: 'f1',
            tag: tagFixture({id: 'b', position: 1}),
        });

        expect(service.tagsFor('f1').map(t => t.id)).toEqual(['a', 'b']);
    });

    it('replaces an updated tag in place', () => {
        const {service, http, ws} = setup();
        service.loadFor('f1');
        flushLoad(http, [tagFixture({id: 'a', name: 'bug'})]);

        ws.emit('guild.ForumTagUpdated', {
            guildId: 'g1',
            channelId: 'f1',
            tag: tagFixture({id: 'a', name: 'confirmed bug'}),
        });

        expect(service.tagsFor('f1')[0].name).toBe('confirmed bug');
    });

    it('drops a deleted tag', () => {
        const {service, http, ws} = setup();
        service.loadFor('f1');
        flushLoad(http, [tagFixture({id: 'a'}), tagFixture({id: 'b', position: 1})]);

        ws.emit('guild.ForumTagDeleted', {guildId: 'g1', channelId: 'f1', tagId: 'a'});

        expect(service.tagsFor('f1').map(t => t.id)).toEqual(['b']);
    });

    /** The event carries the full ordered list, so positions come from the array index. */
    it('re-derives positions from the reorder payload', () => {
        const {service, http, ws} = setup();
        service.loadFor('f1');
        flushLoad(http, [
            tagFixture({id: 'a', position: 0}),
            tagFixture({id: 'b', position: 1}),
            tagFixture({id: 'c', position: 2}),
        ]);

        ws.emit('guild.ForumTagsReordered', {guildId: 'g1', channelId: 'f1', tagIds: ['c', 'a', 'b']});

        expect(service.tagsFor('f1').map(t => t.id)).toEqual(['c', 'a', 'b']);
        expect(service.tagsFor('f1').map(t => t.position)).toEqual([0, 1, 2]);
    });

    /**
     * Inventing a partial list for an unopened forum would make tagsFor() look complete
     * when it isn't - loadFor fetches the authoritative list when the user opens it.
     */
    it('ignores events for forums that were never loaded', () => {
        const {service, ws} = setup();

        ws.emit('guild.ForumTagCreated', {guildId: 'g1', channelId: 'other', tag: tagFixture()});

        expect(service.tagsFor('other')).toEqual([]);
    });
});

describe('ForumStateService view preferences', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('seeds layout and sort from the forum defaults until the user overrides them', () => {
        const {service, http} = setup();
        service.loadFor('f1');
        flushLoad(http, [], {
            channelId: 'f1',
            requireTag: false,
            defaultSortOrder: ForumSortOrder.CreationDate,
            defaultLayout: ForumLayout.Gallery,
            defaultThreadSlowModeSeconds: 0,
            defaultAutoArchiveMinutes: 4320,
        });

        expect(service.layoutFor('f1')).toBe(ForumLayout.Gallery);
        expect(service.sortFor('f1')).toBe(ForumSortOrder.CreationDate);

        service.setLayout('f1', ForumLayout.List);
        service.setSort('f1', ForumSortOrder.LatestActivity);

        expect(service.layoutFor('f1')).toBe(ForumLayout.List);
        expect(service.sortFor('f1')).toBe(ForumSortOrder.LatestActivity);
    });

    it('defaults to a list sorted by activity for a forum with no config', () => {
        const {service} = setup();

        expect(service.layoutFor('unknown')).toBe(ForumLayout.List);
        expect(service.sortFor('unknown')).toBe(ForumSortOrder.LatestActivity);
    });
});
