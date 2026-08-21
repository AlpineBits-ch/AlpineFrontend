import {TestBed} from '@angular/core/testing';
import {Observable, Subject} from 'rxjs';
import {GuildEmojiStore} from './guild-emoji.store';
import {GuildEmojiService} from '../services/guild-emoji.service';
import {RealtimeConnectionService} from '../services/realtime-connection.service';
import {FakeRealtimeConnection} from '../testing/fake-realtime-connection';
import {GuildEmojiDto} from '../dtos/response/guild-emoji.dto';

function emoji(id: string, imageUrl = `https://cdn/${id}?sig=1`): GuildEmojiDto {
    return {
        id,
        guildId: 'g1',
        name: id,
        animated: false,
        createdByUserId: 'u1',
        createdAt: '2026-07-30T00:00:00Z',
        imageUrl,
    };
}

/** Subject-backed fake so response timing is fully controlled and requests can be counted. */
class FakeGuildEmojiService {
    pending: Subject<GuildEmojiDto[]>[] = [];

    getEmojis(_guildId: string): Observable<GuildEmojiDto[]> {
        const subject = new Subject<GuildEmojiDto[]>();
        this.pending.push(subject);
        return subject.asObservable();
    }

    get requestCount(): number {
        return this.pending.length;
    }
}

function setup() {
    const api = new FakeGuildEmojiService();
    const ws = new FakeRealtimeConnection();
    TestBed.configureTestingModule({
        providers: [
            {provide: GuildEmojiService, useValue: api},
            {provide: RealtimeConnectionService, useValue: ws},
        ],
    });
    return {api, ws, store: TestBed.inject(GuildEmojiStore)};
}

describe('GuildEmojiStore', () => {
    it('issues exactly one request for back-to-back ensureLoaded calls', () => {
        const {api, store} = setup();

        store.ensureLoaded('g1');
        store.ensureLoaded('g1');
        store.ensureLoaded('g1');

        expect(api.requestCount).toBe(1);
    });

    it('does not refetch once loaded and fresh', () => {
        const {api, store} = setup();

        store.ensureLoaded('g1');
        api.pending[0].next([emoji('e1')]);
        api.pending[0].complete();

        store.ensureLoaded('g1');

        expect(api.requestCount).toBe(1);
        expect(store.getEmojis('g1').map(e => e.id)).toEqual(['e1']);
    });

    it('drops a stale success that lands after an invalidation, and applies the newer one', () => {
        const {api, store} = setup();

        store.ensureLoaded('g1');
        // Realtime create -> invalidate + ensureLoaded supersedes the in-flight request.
        store.invalidate('g1');
        store.ensureLoaded('g1');
        expect(api.requestCount).toBe(2);

        // The superseded response arrives last and must be ignored.
        api.pending[1].next([emoji('e1'), emoji('e2')]);
        api.pending[1].complete();
        api.pending[0].next([emoji('e1')]);
        api.pending[0].complete();

        expect(store.getEmojis('g1').map(e => e.id)).toEqual(['e1', 'e2']);
    });

    it('lets an invalidation while a fetch is in flight still load fresh data', () => {
        const {api, ws, store} = setup();

        store.ensureLoaded('g1');
        ws.emit('guild.EmojiCreated', {guildId: 'g1', emojiId: 'e2', name: 'e2', animated: false});

        // The loading flag from the superseded fetch must not block the new one.
        expect(api.requestCount).toBe(2);

        api.pending[1].next([emoji('e1'), emoji('e2')]);
        api.pending[1].complete();

        expect(store.getEmojis('g1').map(e => e.id)).toEqual(['e1', 'e2']);
    });

    it('ignores a stale error so it cannot clobber state owned by a newer request', () => {
        const {api, ws, store} = setup();

        store.ensureLoaded('g1');
        api.pending[0].next([emoji('e1'), emoji('e2')]);
        api.pending[0].complete();

        // Force a revalidation, then delete an emoji while it is in flight.
        store.invalidate('g1');
        store.ensureLoaded('g1');
        ws.emit('guild.EmojiDeleted', {guildId: 'g1', emojiId: 'e1'});
        expect(store.getEmojis('g1').map(e => e.id)).toEqual(['e2']);

        // A superseded request failing must not write anything back.
        store.invalidate('g1');
        store.ensureLoaded('g1');
        api.pending[1].error(new Error('boom'));

        expect(store.getEmojis('g1').map(e => e.id)).toEqual(['e2']);

        api.pending[2].next([emoji('e2')]);
        api.pending[2].complete();
        expect(store.getEmojis('g1').map(e => e.id)).toEqual(['e2']);
    });

    it('clears the loading flag on error so a later ensureLoaded can retry', () => {
        const {api, store} = setup();

        store.ensureLoaded('g1');
        api.pending[0].error(new Error('boom'));

        store.ensureLoaded('g1');

        expect(api.requestCount).toBe(2);
    });
});
