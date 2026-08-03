import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {Subject} from 'rxjs';

import {GuildReadStateService} from './guild-read-state.service';
import {GuildWebsocketService} from './guild-websocket.service';
import {ApiConfigService} from './api-config.service';
import {ProfileService} from './profile.service';

const BASE = 'https://api.test.example';
const UNREAD = `${BASE}/api/v1/guild/inbox/unread?limit=25`;

function setup() {
    const ws = {messageObservable: new Subject<any>()};
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
            {provide: GuildWebsocketService, useValue: ws},
            // A mention only counts when it names the signed-in user, so the service needs
            // an own-profile to compare against or every mention silently scores zero.
            {provide: ProfileService, useValue: {ownProfile: () => ({userId: 'me'})}},
        ],
    });
    return {
        service: TestBed.inject(GuildReadStateService),
        ws,
        ctrl: TestBed.inject(HttpTestingController),
    };
}

/** One unread group, in the shape the inbox serves it. */
function group(channelId: string, mentionCount = 0) {
    return {
        breadcrumb: {
            guildId: 'gild_1', guildName: 'Echo', guildIconUrl: '', guildIconThumbnailUrl: '',
            categoryId: null, categoryName: null, channelId, channelName: 'general',
            channelType: 0, parentChannelId: null, parentChannelName: null,
        },
        lastActivityAt: '2026-08-03T10:14:22.115Z',
        unreadCount: 3,
        mentionCount,
        previews: [],
        previewsTruncated: false,
    };
}

/** Drives state in through the one public path that creates it: an incoming message. */
function deliver(ws: {messageObservable: Subject<any>}, channelId: string, mentions: string[] = []) {
    ws.messageObservable.next({channelId, mentions});
}

describe('GuildReadStateService.ensureSeeded', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('seeds unread state from the inbox, not from the member read state', async () => {
        const {service, ctrl} = setup();
        // `member.readState[].mentionCount` is always 0 now, so the seed has to come from here.
        const done = service.ensureSeeded();
        ctrl.expectOne(UNREAD).flush({
            groups: [group('c1', 2), group('c2')],
            nextCursor: null,
            previewsUnavailable: false,
        });
        await done;

        expect(service.getChannelState('c1')).toEqual({isUnread: true, mentionCount: 2});
        expect(service.getChannelState('c2')).toEqual({isUnread: true, mentionCount: 0});
    });

    it('keeps paging past an empty page that still has a cursor', async () => {
        const {service, ctrl} = setup();
        const done = service.ensureSeeded();
        // Muting and permission filtering happen after the page is taken, so this is not the end.
        ctrl.expectOne(UNREAD)
            .flush({groups: [], nextCursor: 'c1', previewsUnavailable: false});
        await Promise.resolve();
        ctrl.expectOne(`${UNREAD}&cursor=c1`)
            .flush({groups: [group('c9', 4)], nextCursor: null, previewsUnavailable: false});
        await done;

        expect(service.getChannelState('c9').mentionCount).toBe(4);
    });

    it('runs once across every guild rather than once per guild', async () => {
        const {service, ctrl} = setup();
        const done = service.ensureSeeded();
        ctrl.expectOne(UNREAD)
            .flush({groups: [], nextCursor: null, previewsUnavailable: false});
        await done;

        await service.ensureSeeded();
        ctrl.verify();
    });

    it('does not clobber a live state that raced the seed', async () => {
        const {service, ws, ctrl} = setup();
        const done = service.ensureSeeded();
        deliver(ws, 'c1', ['me']);
        ctrl.expectOne(UNREAD)
            .flush({groups: [group('c1', 0)], nextCursor: null, previewsUnavailable: false});
        await done;

        // The websocket increment is fresher than the page it raced.
        expect(service.getChannelState('c1').mentionCount).toBe(1);
    });

    it('stays unseeded after a failure so the next guild switch retries', async () => {
        const {service, ctrl} = setup();
        const first = service.ensureSeeded();
        ctrl.expectOne(UNREAD).flush(null, {status: 500, statusText: 'Server Error'});
        await first;

        const second = service.ensureSeeded();
        ctrl.expectOne(UNREAD)
            .flush({groups: [group('c1', 1)], nextCursor: null, previewsUnavailable: false});
        await second;

        expect(service.getChannelState('c1').mentionCount).toBe(1);
    });
});

describe('GuildReadStateService.aggregate', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('is silent for ids it has never seen', () => {
        const {service} = setup();

        expect(service.aggregate(['nothing', 'here'])).toEqual({isUnread: false, mentionCount: 0});
    });

    it('is silent for an empty list', () => {
        const {service} = setup();

        expect(service.aggregate([])).toEqual({isUnread: false, mentionCount: 0});
    });

    /**
     * A forum holds no messages of its own, so its row can only ever report activity by
     * reading its posts - one unread post has to surface on the forum above it.
     */
    it('reports unread when any one id is unread', () => {
        const {service, ws} = setup();
        deliver(ws, 'p2');

        expect(service.aggregate(['p1', 'p2', 'p3']).isUnread).toBe(true);
    });

    it('sums mentions across ids', () => {
        const {service, ws} = setup();
        deliver(ws, 'p1', ['me']);
        deliver(ws, 'p1', ['me']);
        deliver(ws, 'p3', ['me']);

        expect(service.aggregate(['p1', 'p2', 'p3']).mentionCount).toBe(3);
    });

    it('counts each id once, not once per appearance', () => {
        const {service, ws} = setup();
        deliver(ws, 'p1', ['me']);

        expect(service.aggregate(['p1']).mentionCount).toBe(1);
    });

    /** The forum's own id contributes nothing, which is exactly why the rollup exists. */
    it('ignores ids with no state while still counting the rest', () => {
        const {service, ws} = setup();
        deliver(ws, 'p1', ['me']);

        expect(service.aggregate(['forum-itself', 'p1'])).toEqual({isUnread: true, mentionCount: 1});
    });

    it('goes quiet again once the unread id is marked read', () => {
        const {service, ws} = setup();
        deliver(ws, 'p1', ['me']);
        service.markChannelRead('p1');

        expect(service.aggregate(['p1'])).toEqual({isUnread: false, mentionCount: 0});
    });
});

describe('GuildReadStateService.channelRead$', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('announces a channel going from unread to read', () => {
        const {service, ws} = setup();
        const seen: string[] = [];
        service.channelRead$.subscribe(id => seen.push(id));

        deliver(ws, 'p1', ['me']);
        service.markChannelRead('p1');

        expect(seen).toEqual(['p1']);
    });

    /**
     * The channel view re-marks its channel read on every message that lands while it is open, and
     * the server-taskbar's Mark as read walks a whole guild whether or not a channel was unread. A
     * badge refetch on each of those would be asking a question whose answer cannot have changed.
     */
    it('stays silent when the channel was already read', () => {
        const {service, ws} = setup();
        const seen: string[] = [];
        service.channelRead$.subscribe(id => seen.push(id));

        deliver(ws, 'p1', ['me']);
        service.markChannelRead('p1');
        service.markChannelRead('p1');
        service.markChannelRead('never-unread');

        expect(seen).toEqual(['p1']);
    });
});
