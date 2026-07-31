import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {provideHttpClientTesting} from '@angular/common/http/testing';
import {Subject} from 'rxjs';

import {GuildReadStateService} from './guild-read-state.service';
import {GuildWebsocketService} from './guild-websocket.service';
import {ApiConfigService} from './api-config.service';
import {ProfileService} from './profile.service';

function setup() {
    const ws = {messageObservable: new Subject<any>()};
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            {provide: GuildWebsocketService, useValue: ws},
            // A mention only counts when it names the signed-in user, so the service needs
            // an own-profile to compare against or every mention silently scores zero.
            {provide: ProfileService, useValue: {ownProfile: () => ({userId: 'me'})}},
        ],
    });
    return {service: TestBed.inject(GuildReadStateService), ws};
}

/** Drives state in through the one public path that creates it: an incoming message. */
function deliver(ws: {messageObservable: Subject<any>}, channelId: string, mentions: string[] = []) {
    ws.messageObservable.next({channelId, mentions});
}

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
