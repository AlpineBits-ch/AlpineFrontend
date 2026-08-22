import {TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';
import {Observable, Subject, throwError} from 'rxjs';
import {ProfileCanvasStore} from './profile-canvas.store';
import {ProfileCanvasApiService} from '../services/profile-canvas-api.service';
import {CanvasWriteDto, ProfileCanvasDto} from '../dtos/response/profile-canvas.dto';
import {RealtimeConnectionService} from '../services/realtime-connection.service';
import {FakeRealtimeConnection} from '../testing/fake-realtime-connection';

function canvas(profileId: string, widgetCount = 1): ProfileCanvasDto {
    return {
        profileId,
        updatedAt: '2026-08-22T00:00:00Z',
        version: 1,
        theme: {accent: null, backdrop: null},
        widgets: Array.from({length: widgetCount}, (_, i) => ({
            id: `w${i}`,
            type: 'quote',
            x: 0,
            y: i,
            w: 2,
            h: 1,
            visibility: 'everyone' as const,
            card: false,
            config: {text: 'hi'},
        })),
    };
}

class FakeApi {
    gets: Subject<ProfileCanvasDto>[] = [];
    saves: Subject<ProfileCanvasDto>[] = [];
    saveFails = false;

    get(_profileId: string): Observable<ProfileCanvasDto> {
        const subject = new Subject<ProfileCanvasDto>();
        this.gets.push(subject);
        return subject.asObservable();
    }

    save(_body: CanvasWriteDto): Observable<ProfileCanvasDto> {
        if (this.saveFails) return throwError(() => new Error('nope'));
        const subject = new Subject<ProfileCanvasDto>();
        this.saves.push(subject);
        return subject.asObservable();
    }
}

function setup() {
    const api = new FakeApi();
    const realtime = new FakeRealtimeConnection();
    TestBed.configureTestingModule({
        providers: [
            {provide: ProfileCanvasApiService, useValue: api},
            {provide: RealtimeConnectionService, useValue: realtime},
        ],
    });
    return {api, realtime, store: TestBed.inject(ProfileCanvasStore)};
}

describe('ProfileCanvasStore', () => {
    it('answers undefined for a profile it has not loaded', () => {
        const {store} = setup();
        expect(store.canvasFor('p1')).toBeUndefined();
    });

    it('canvasFor never issues a request', () => {
        const {api, store} = setup();
        store.canvasFor('p1');
        expect(api.gets).toHaveLength(0);
    });

    it('ensureLoaded fetches once and caches the result', () => {
        const {api, store} = setup();
        store.ensureLoaded('p1');
        api.gets[0].next(canvas('p1'));
        api.gets[0].complete();

        expect(store.canvasFor('p1')?.profileId).toBe('p1');
        store.ensureLoaded('p1');
        expect(api.gets).toHaveLength(1);
    });

    it('does not start a second fetch while one is in flight', () => {
        const {api, store} = setup();
        store.ensureLoaded('p1');
        store.ensureLoaded('p1');
        expect(api.gets).toHaveLength(1);
    });

    it('normalises what the server sent', () => {
        const {api, store} = setup();
        store.ensureLoaded('p1');
        const wide = canvas('p1');
        wide.widgets[0].w = 9;
        api.gets[0].next(wide);

        expect(store.canvasFor('p1')?.widgets[0].w).toBe(4);
    });

    it('leaves the cache alone when the fetch fails, and a later ensureLoaded retries', () => {
        const {api, store} = setup();
        store.ensureLoaded('p1');
        api.gets[0].error(new Error('boom'));
        expect(store.canvasFor('p1')).toBeUndefined();

        store.ensureLoaded('p1');
        expect(api.gets).toHaveLength(2);
    });

    it('applies a save optimistically and keeps the server answer', () => {
        const {api, store} = setup();
        store.ensureLoaded('p1');
        api.gets[0].next(canvas('p1', 1));

        store.save(canvas('p1', 3)).subscribe();
        expect(store.canvasFor('p1')?.widgets).toHaveLength(3);

        api.saves[0].next(canvas('p1', 3));
        api.saves[0].complete();
        expect(store.canvasFor('p1')?.widgets).toHaveLength(3);
    });

    it('rolls the optimistic write back when the save fails', () => {
        const {api, store} = setup();
        store.ensureLoaded('p1');
        api.gets[0].next(canvas('p1', 1));

        api.saveFails = true;
        store.save(canvas('p1', 3)).subscribe({error: () => undefined});

        expect(store.canvasFor('p1')?.widgets).toHaveLength(1);
    });

    it('drops the entry, rather than stranding the optimistic write, when a save fails on a profile never loaded', () => {
        const {api, store} = setup();
        api.saveFails = true;

        store.save(canvas('p1', 3)).subscribe({error: () => undefined});
        expect(store.canvasFor('p1')).toBeUndefined();

        store.ensureLoaded('p1');
        expect(api.gets).toHaveLength(1);
    });

    it('recovers ensureLoaded after a save fails while a load was still in flight', () => {
        const {api, store} = setup();
        store.ensureLoaded('p1');

        api.saveFails = true;
        store.save(canvas('p1', 3)).subscribe({error: () => undefined});

        store.ensureLoaded('p1');
        expect(api.gets).toHaveLength(2);
    });

    it('keeps a later save when an earlier one resolves after it', () => {
        const {api, store} = setup();
        store.ensureLoaded('p1');
        api.gets[0].next(canvas('p1', 1));

        store.save(canvas('p1', 2)).subscribe();
        store.save(canvas('p1', 5)).subscribe();

        api.saves[0].next(canvas('p1', 2));
        api.saves[0].complete();

        expect(store.canvasFor('p1')?.widgets).toHaveLength(5);
    });

    it('applies a realtime update to a canvas it holds', () => {
        const {api, realtime, store} = setup();
        store.ensureLoaded('p1');
        api.gets[0].next(canvas('p1', 1));

        realtime.emit('social.ProfileCanvasUpdated', {profileId: 'p1', canvas: canvas('p1', 3)});

        expect(store.canvasFor('p1')?.widgets).toHaveLength(3);
    });

    it('normalises what the event carried', () => {
        const {api, realtime, store} = setup();
        store.ensureLoaded('p1');
        api.gets[0].next(canvas('p1', 1));

        const wide = canvas('p1', 1);
        wide.widgets[0].w = 9;
        realtime.emit('social.ProfileCanvasUpdated', {profileId: 'p1', canvas: wide});

        expect(store.canvasFor('p1')?.widgets[0].w).toBe(4);
    });

    it('ignores an event for a profile it never loaded', () => {
        const {realtime, store} = setup();
        realtime.emit('social.ProfileCanvasUpdated', {profileId: 'p9', canvas: canvas('p9', 2)});
        expect(store.canvasFor('p9')).toBeUndefined();
    });

    it('does not let an event clobber a save in flight', () => {
        const {api, realtime, store} = setup();
        store.ensureLoaded('p1');
        api.gets[0].next(canvas('p1', 1));

        store.save(canvas('p1', 5)).subscribe();
        realtime.emit('social.ProfileCanvasUpdated', {profileId: 'p1', canvas: canvas('p1', 2)});

        expect(store.canvasFor('p1')?.widgets).toHaveLength(5);
    });

    it('applies an event for a different profile while another one is saving', () => {
        const {api, realtime, store} = setup();
        store.ensureLoaded('p1');
        api.gets[0].next(canvas('p1', 1));
        store.ensureLoaded('p2');
        api.gets[1].next(canvas('p2', 1));

        store.save(canvas('p1', 5)).subscribe();
        realtime.emit('social.ProfileCanvasUpdated', {profileId: 'p2', canvas: canvas('p2', 3)});

        expect(store.canvasFor('p2')?.widgets).toHaveLength(3);
    });

    it('still ignores an event for the profile that is itself saving, with another profile also held', () => {
        const {api, realtime, store} = setup();
        store.ensureLoaded('p1');
        api.gets[0].next(canvas('p1', 1));
        store.ensureLoaded('p2');
        api.gets[1].next(canvas('p2', 1));

        store.save(canvas('p1', 5)).subscribe();
        realtime.emit('social.ProfileCanvasUpdated', {profileId: 'p1', canvas: canvas('p1', 2)});

        expect(store.canvasFor('p1')?.widgets).toHaveLength(5);
    });

    it('applies an event for a profile again once its own save has failed', () => {
        const {api, realtime, store} = setup();
        store.ensureLoaded('p1');
        api.gets[0].next(canvas('p1', 1));

        api.saveFails = true;
        store.save(canvas('p1', 5)).subscribe({error: () => undefined});
        realtime.emit('social.ProfileCanvasUpdated', {profileId: 'p1', canvas: canvas('p1', 3)});

        expect(store.canvasFor('p1')?.widgets).toHaveLength(3);
    });

    it('does not let an event clobber a second save while its predecessor is still resolving', () => {
        const {api, realtime, store} = setup();
        store.ensureLoaded('p1');
        api.gets[0].next(canvas('p1', 1));

        store.save(canvas('p1', 2)).subscribe();
        store.save(canvas('p1', 5)).subscribe();

        api.saves[0].next(canvas('p1', 2));
        api.saves[0].complete();

        realtime.emit('social.ProfileCanvasUpdated', {profileId: 'p1', canvas: canvas('p1', 9)});

        expect(store.canvasFor('p1')?.widgets).toHaveLength(5);
    });
});
