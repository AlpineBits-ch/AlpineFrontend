import {inject, Injectable} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {HttpErrorResponse} from '@angular/common/http';
import {Observable, Subject} from 'rxjs';
import {signalStore} from '@ngrx/signals';
import {withEntities} from '@ngrx/signals/entities';
import {withKeyedIndex} from './with-keyed-index';

interface Row {
    id: string;
    name: string;
}

function row(id: string, name = id): Row {
    return {id, name};
}

/** Subject-backed so response timing is fully controlled and requests can be counted per collection. */
@Injectable({providedIn: 'root'})
class FakeApi {
    readonly stockCalls: string[] = [];
    readonly ownerCalls: string[] = [];
    readonly stockPending: Subject<Row[]>[] = [];
    readonly ownerPending: Subject<Row[]>[] = [];

    listStock(key: string): Observable<Row[]> {
        this.stockCalls.push(key);
        const subject = new Subject<Row[]>();
        this.stockPending.push(subject);
        return subject.asObservable();
    }

    listByOwner(key: string): Observable<Row[]> {
        this.ownerCalls.push(key);
        const subject = new Subject<Row[]>();
        this.ownerPending.push(subject);
        return subject.asObservable();
    }
}

const TestStore = signalStore(
    {providedIn: 'root'},
    withEntities<Row>(),
    withKeyedIndex<Row, 'stock'>({
        collection: 'stock',
        staleMs: 60_000,
        sort: (a, b) => a.name.localeCompare(b.name),
        fetch: () => {
            const api = inject(FakeApi);
            return (key: string) => api.listStock(key);
        },
    }),
    withKeyedIndex<Row, 'byOwner'>({
        collection: 'byOwner',
        fetch: () => {
            const api = inject(FakeApi);
            return (key: string) => api.listByOwner(key);
        },
    }),
);

function setup() {
    TestBed.configureTestingModule({});
    return {store: TestBed.inject(TestStore), api: TestBed.inject(FakeApi)};
}

function settle(pending: Subject<Row[]>[], index: number, rows: Row[]): void {
    pending[index].next(rows);
    pending[index].complete();
}

describe('withKeyedIndex', () => {
    afterEach(() => vi.restoreAllMocks());

    describe('reads', () => {
        it('serves an untracked key as empty without recording it', () => {
            const {store, api} = setup();
            expect(store.stockFor('c1')()).toEqual([]);
            expect(store.stockTracked('c1')).toBe(false);
            expect(store.stockLoaded('c1')).toBe(false);
            expect(api.stockCalls).toEqual([]);
        });

        it('hands back the same signal and the same array across two reads', () => {
            const {store, api} = setup();
            store.loadStock('c1');
            settle(api.stockPending, 0, [row('a'), row('b')]);

            expect(store.stockFor('c1')).toBe(store.stockFor('c1'));
            expect(store.stockFor('c1')()).toBe(store.stockFor('c1')());
        });

        it('applies the configured sort rather than the id order', () => {
            const {store, api} = setup();
            store.loadStock('c1');
            settle(api.stockPending, 0, [row('b', 'Rice'), row('a', 'Butter')]);

            expect(
                store
                    .stockFor('c1')()
                    .map(r => r.name),
            ).toEqual(['Butter', 'Rice']);
        });

        it('leaves the id order alone when no sort is configured', () => {
            const {store, api} = setup();
            store.loadByOwner('u1');
            settle(api.ownerPending, 0, [row('b', 'Rice'), row('a', 'Butter')]);

            expect(
                store
                    .byOwnerFor('u1')()
                    .map(r => r.name),
            ).toEqual(['Rice', 'Butter']);
        });
    });

    describe('the staleness gate', () => {
        it('serves a second load from cache', () => {
            const {store, api} = setup();
            store.loadStock('c1');
            settle(api.stockPending, 0, []);
            store.loadStock('c1');

            expect(api.stockCalls).toEqual(['c1']);
        });

        it('refetches past staleMs', () => {
            const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
            const {store, api} = setup();
            store.loadStock('c1');
            settle(api.stockPending, 0, []);

            now.mockReturnValue(1_000_000 + 60_001);
            store.loadStock('c1');

            expect(api.stockCalls).toEqual(['c1', 'c1']);
        });

        it('never goes stale by time when staleMs is omitted', () => {
            const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
            const {store, api} = setup();
            store.loadByOwner('u1');
            settle(api.ownerPending, 0, []);

            now.mockReturnValue(1_000_000 + 86_400_000);
            store.loadByOwner('u1');

            expect(api.ownerCalls).toEqual(['u1']);
        });

        it('refetches a fresh key on force', () => {
            const {store, api} = setup();
            store.loadStock('c1');
            settle(api.stockPending, 0, []);
            store.loadStock('c1', {force: true});

            expect(api.stockCalls).toEqual(['c1', 'c1']);
        });

        it('refetches after an invalidation', () => {
            const {store, api} = setup();
            store.loadStock('c1');
            settle(api.stockPending, 0, []);
            store.invalidateStock('c1');
            store.loadStock('c1');

            expect(api.stockCalls).toEqual(['c1', 'c1']);
        });

        it('ignores an invalidation for a key nobody fetched', () => {
            const {store} = setup();
            store.invalidateStock('c1');

            expect(store.stockTracked('c1')).toBe(false);
        });
    });

    describe('in-flight requests', () => {
        it('coalesces back-to-back loads into one request', () => {
            const {store, api} = setup();
            store.loadStock('c1');
            store.loadStock('c1');
            store.loadStock('c1');

            expect(api.stockCalls).toEqual(['c1']);
            expect(store.stockLoading('c1')).toBe(true);
        });

        it('runs a refetch queued while a request was in flight', () => {
            const {store, api} = setup();
            store.loadStock('c1');
            store.invalidateStock('c1');
            store.loadStock('c1');
            expect(api.stockCalls).toEqual(['c1']);

            settle(api.stockPending, 0, [row('a')]);

            expect(api.stockCalls).toEqual(['c1', 'c1']);
            expect(store.stockLoading('c1')).toBe(true);
        });

        it('drains a queued refetch after a failure too', () => {
            const {store, api} = setup();
            store.loadStock('c1');
            store.loadStock('c1', {force: true});
            api.stockPending[0].error(new HttpErrorResponse({status: 500}));

            expect(api.stockCalls).toEqual(['c1', 'c1']);
        });

        it('queues at most one refetch however many arrive', () => {
            const {store, api} = setup();
            store.loadStock('c1');
            store.loadStock('c1', {force: true});
            store.loadStock('c1', {force: true});
            settle(api.stockPending, 0, []);

            expect(api.stockCalls).toEqual(['c1', 'c1']);
        });
    });

    describe('failures', () => {
        it('leaves the key unloaded and retryable', () => {
            const {store, api} = setup();
            store.loadStock('c1');
            api.stockPending[0].error(new HttpErrorResponse({status: 500}));

            expect(store.stockLoaded('c1')).toBe(false);
            expect(store.stockTracked('c1')).toBe(true);
            expect(store.stockLoading('c1')).toBe(false);
            expect(store.stockError('c1')).toBe('failed');

            store.loadStock('c1');
            expect(api.stockCalls).toEqual(['c1', 'c1']);
        });

        it('keeps forbidden distinct from failed', () => {
            const {store, api} = setup();
            store.loadStock('c1');
            api.stockPending[0].error(new HttpErrorResponse({status: 403}));

            expect(store.stockError('c1')).toBe('forbidden');
        });

        it('leaves an empty answer distinguishable from a refused one', () => {
            const {store, api} = setup();
            store.loadStock('c1');
            settle(api.stockPending, 0, []);
            store.loadStock('c2');
            api.stockPending[1].error(new HttpErrorResponse({status: 403}));

            expect(store.stockFor('c1')()).toEqual([]);
            expect(store.stockLoaded('c1')).toBe(true);
            expect(store.stockFor('c2')()).toEqual([]);
            expect(store.stockLoaded('c2')).toBe(false);
        });

        it('clears the error when a retry succeeds', () => {
            const {store, api} = setup();
            store.loadStock('c1');
            api.stockPending[0].error(new HttpErrorResponse({status: 500}));
            store.loadStock('c1');
            settle(api.stockPending, 1, [row('a')]);

            expect(store.stockError('c1')).toBe(null);
            expect(store.stockLoaded('c1')).toBe(true);
        });
    });

    describe('writes into a key', () => {
        it('replaces the key list on apply and upserts the entities', () => {
            const {store} = setup();
            store.applyStock('c1', [row('a'), row('b')]);
            store.applyStock('c1', [row('b'), row('c')]);

            expect(
                store
                    .stockFor('c1')()
                    .map(r => r.id),
            ).toEqual(['b', 'c']);
            expect(store.entityMap()['a']).toBeDefined();
        });

        it('appends on attach and is idempotent for an id it already holds', () => {
            const {store} = setup();
            store.applyStock('c1', [row('a')]);
            store.attachToStock('c1', row('b', 'Zed'));
            store.attachToStock('c1', row('b', 'Zed again'));

            expect(
                store
                    .stockFor('c1')()
                    .map(r => r.id),
            ).toEqual(['a', 'b']);
            expect(store.entityMap()['b'].name).toBe('Zed again');
        });

        it('drops the id on detach without touching the entity', () => {
            const {store} = setup();
            store.applyStock('c1', [row('a'), row('b')]);
            store.detachFromStock('c1', 'a');

            expect(
                store
                    .stockFor('c1')()
                    .map(r => r.id),
            ).toEqual(['b']);
            expect(store.entityMap()['a']).toBeDefined();
        });
    });

    describe('Held, LoadedAt and invalidateAll', () => {
        it('holds a key a write reached but no fetch did', () => {
            const {store} = setup();
            store.applyStock('c1', [row('a')]);

            expect(store.stockTracked('c1')).toBe(false);
            expect(store.stockHeld('c1')).toBe(true);
        });

        it('holds a key a fetch reached but no rows did', () => {
            const {store, api} = setup();
            store.loadStock('c1');
            api.stockPending[0].error(new HttpErrorResponse({status: 403}));

            expect(store.stockHeld('c1')).toBe(true);
        });

        it('stays false for a key nothing has touched', () => {
            const {store} = setup();
            expect(store.stockHeld('c1')).toBe(false);
        });

        it('stays true once the last row of a key is detached', () => {
            const {store} = setup();
            store.applyStock('c1', [row('a')]);
            store.detachFromStock('c1', 'a');

            expect(store.stockFor('c1')()).toEqual([]);
            expect(store.stockHeld('c1')).toBe(true);
        });

        it('reads the last success stamp back, and zero after an invalidation', () => {
            vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
            const {store, api} = setup();
            store.loadStock('c1');
            settle(api.stockPending, 0, []);
            expect(store.stockLoadedAt('c1')).toBe(1_000_000);

            store.invalidateStock('c1');
            expect(store.stockLoadedAt('c1')).toBe(0);
        });

        it('reads zero for a key nobody fetched', () => {
            const {store} = setup();
            expect(store.stockLoadedAt('c1')).toBe(0);
        });

        it('invalidates every tracked key at once', () => {
            const {store, api} = setup();
            store.loadStock('c1');
            settle(api.stockPending, 0, []);
            store.loadStock('c2');
            settle(api.stockPending, 1, []);

            store.invalidateAllStock();
            store.loadStock('c1');
            store.loadStock('c2');

            expect(api.stockCalls).toEqual(['c1', 'c2', 'c1', 'c2']);
        });

        it('leaves the other index alone', () => {
            const {store, api} = setup();
            store.loadStock('c1');
            settle(api.stockPending, 0, []);
            store.loadByOwner('c1');
            settle(api.ownerPending, 0, []);

            store.invalidateAllStock();
            store.loadByOwner('c1');

            expect(api.ownerCalls).toEqual(['c1']);
        });
    });

    describe('two indexes over one entity map', () => {
        it('keeps separate key lists and request state', () => {
            const {store, api} = setup();
            store.loadStock('c1');
            settle(api.stockPending, 0, [row('a'), row('b')]);
            store.loadByOwner('u1');
            settle(api.ownerPending, 0, [row('a')]);

            expect(
                store
                    .stockFor('c1')()
                    .map(r => r.id),
            ).toEqual(['a', 'b']);
            expect(
                store
                    .byOwnerFor('u1')()
                    .map(r => r.id),
            ).toEqual(['a']);
            expect(store.stockLoaded('u1')).toBe(false);
            expect(store.byOwnerLoaded('c1')).toBe(false);
        });

        it("keeps one key's array reference across a write to another key", () => {
            const {store, api} = setup();
            store.loadStock('c1');
            settle(api.stockPending, 0, [row('a')]);
            const before = store.stockFor('c1')();

            store.applyStock('c2', [row('b')]);
            store.attachToStock('c2', row('c'));

            expect(store.stockFor('c1')()).toBe(before);
        });

        it('shows an entity written through one index in the other', () => {
            const {store, api} = setup();
            store.loadStock('c1');
            settle(api.stockPending, 0, [row('a', 'Milk')]);
            store.loadByOwner('u1');
            settle(api.ownerPending, 0, [row('a', 'Milk')]);

            store.attachToStock('c1', row('a', 'Oat milk'));

            expect(store.byOwnerFor('u1')()[0].name).toBe('Oat milk');
        });

        it('detaching from one index leaves the other holding the row', () => {
            const {store} = setup();
            store.applyStock('c1', [row('a')]);
            store.applyByOwner('u1', [row('a')]);
            store.detachFromStock('c1', 'a');

            expect(store.stockFor('c1')()).toEqual([]);
            expect(
                store
                    .byOwnerFor('u1')()
                    .map(r => r.id),
            ).toEqual(['a']);
        });
    });
});
