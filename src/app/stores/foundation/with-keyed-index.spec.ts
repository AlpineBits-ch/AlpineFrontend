import {inject, Injectable} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {HttpErrorResponse} from '@angular/common/http';
import {Observable, Subject} from 'rxjs';
import {signalStore, type, watchState, withState} from '@ngrx/signals';
import {withEntities} from '@ngrx/signals/entities';
import {withKeyedIndex} from './with-keyed-index';

interface Row {
    id: string;
    name: string;
}

/** A second row type, so the named-collection store holds two shapes that share no fields. */
interface Tag {
    id: string;
    label: string;
}

function row(id: string, name = id): Row {
    return {id, name};
}

function tag(id: string, label = id): Tag {
    return {id, label};
}

/** A response that is not the rows: what `rows`, `onLoaded` and `paging` exist for. */
interface Page {
    items: Row[];
    total: number;
    cursor: string | null;
}

function page(items: Row[], cursor: string | null = null, total = items.length): Page {
    return {items, total, cursor};
}

interface Totals {
    totalByKey: Record<string, number>;
}

/** Subject-backed so response timing is fully controlled and requests can be counted per collection. */
@Injectable({providedIn: 'root'})
class FakeApi {
    readonly stockCalls: string[] = [];
    readonly ownerCalls: string[] = [];
    readonly tagCalls: string[] = [];
    readonly pageCalls: string[] = [];
    readonly afterCalls: string[] = [];
    readonly stockPending: Subject<Row[]>[] = [];
    readonly ownerPending: Subject<Row[]>[] = [];
    readonly tagPending: Subject<Tag[]>[] = [];
    readonly pagePending: Subject<Page>[] = [];
    readonly afterPending: Subject<Page>[] = [];

    listStock(key: string): Observable<Row[]> {
        this.stockCalls.push(key);
        const subject = new Subject<Row[]>();
        this.stockPending.push(subject);
        return subject.asObservable();
    }

    listTags(key: string): Observable<Tag[]> {
        this.tagCalls.push(key);
        const subject = new Subject<Tag[]>();
        this.tagPending.push(subject);
        return subject.asObservable();
    }

    listByOwner(key: string): Observable<Row[]> {
        this.ownerCalls.push(key);
        const subject = new Subject<Row[]>();
        this.ownerPending.push(subject);
        return subject.asObservable();
    }

    listPage(key: string): Observable<Page> {
        this.pageCalls.push(key);
        const subject = new Subject<Page>();
        this.pagePending.push(subject);
        return subject.asObservable();
    }

    listPageAfter(key: string, cursor: string): Observable<Page> {
        this.afterCalls.push(cursor);
        const subject = new Subject<Page>();
        this.afterPending.push(subject);
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

/** Two row types in one store, each with its own named entity collection and its own index. */
const NamedStore = signalStore(
    {providedIn: 'root'},
    withEntities<Row, 'row'>({entity: type<Row>(), collection: 'row'}),
    withEntities<Tag, 'tag'>({entity: type<Tag>(), collection: 'tag'}),
    withKeyedIndex<Row, 'stock', 'row'>({
        collection: 'stock',
        entities: 'row',
        sort: (a, b) => a.name.localeCompare(b.name),
        fetch: () => {
            const api = inject(FakeApi);
            return (key: string) => api.listStock(key);
        },
    }),
    withKeyedIndex<Tag, 'tags', 'tag'>({
        collection: 'tags',
        entities: 'tag',
        fetch: () => {
            const api = inject(FakeApi);
            return (key: string) => api.listTags(key);
        },
    }),
);

// A collection name the store never declared. The error lands on `signalStore(`, not on the
// `withKeyedIndex(` argument, so a directive inside the argument list suppresses nothing.
// @ts-expect-error - 'nope' names no entity collection on this store.
const _WrongCollection = signalStore(
    withEntities<Row, 'row'>({entity: type<Row>(), collection: 'row'}),
    withKeyedIndex<Row, 'stock', 'nope'>({
        collection: 'stock',
        entities: 'nope',
        fetch: () => () => new Subject<Row[]>().asObservable(),
    }),
);

/** Newest first without a sort, plus cursor paging: the decision and ledger shapes together. */
const PagedStore = signalStore(
    {providedIn: 'root'},
    withEntities<Row>(),
    withKeyedIndex<Row, 'stock', never, Page>({
        collection: 'stock',
        insertAt: 'start',
        fetch: () => {
            const api = inject(FakeApi);
            return (key: string) => api.listPage(key);
        },
        rows: response => response.items,
        paging: {
            cursorOf: response => response.cursor,
            fetch: () => {
                const api = inject(FakeApi);
                return (key: string, cursor: string) => api.listPageAfter(key, cursor);
            },
        },
    }),
);

/** A response that carries more than the rows, and sibling state written from the rest of it. */
const MetaStore = signalStore(
    {providedIn: 'root'},
    withEntities<Row>(),
    withState<Totals>({totalByKey: {}}),
    withKeyedIndex<Row, 'stock', never, Page, Totals>({
        collection: 'stock',
        fetch: () => {
            const api = inject(FakeApi);
            return (key: string) => api.listPage(key);
        },
        rows: response => response.items,
        onLoaded: (response, key, state) => ({totalByKey: {...state.totalByKey, [key]: response.total}}),
    }),
);

function setup() {
    TestBed.configureTestingModule({});
    return {store: TestBed.inject(TestStore), api: TestBed.inject(FakeApi)};
}

function setupMeta() {
    TestBed.configureTestingModule({});
    return {store: TestBed.inject(MetaStore), api: TestBed.inject(FakeApi)};
}

function setupPaged() {
    TestBed.configureTestingModule({});
    return {store: TestBed.inject(PagedStore), api: TestBed.inject(FakeApi)};
}

function setupNamed() {
    TestBed.configureTestingModule({});
    return {store: TestBed.inject(NamedStore), api: TestBed.inject(FakeApi)};
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

    describe('an invalidation while a request is out', () => {
        it('keeps the key stale when the response lands', () => {
            const {store, api} = setup();
            store.loadStock('c1');
            store.invalidateStock('c1');
            settle(api.stockPending, 0, [row('a')]);

            expect(store.stockLoaded('c1')).toBe(false);
            expect(store.stockLoadedAt('c1')).toBe(0);
        });

        it('still takes the rows the response carried', () => {
            const {store, api} = setup();
            store.loadStock('c1');
            store.invalidateStock('c1');
            settle(api.stockPending, 0, [row('a')]);

            expect(
                store
                    .stockFor('c1')()
                    .map(r => r.id),
            ).toEqual(['a']);
        });

        it('refetches on the next load rather than answering from the superseded response', () => {
            const {store, api} = setup();
            store.loadStock('c1');
            store.invalidateStock('c1');
            settle(api.stockPending, 0, [row('a')]);
            store.loadStock('c1');

            expect(api.stockCalls).toEqual(['c1', 'c1']);
        });

        it('reports a clean load as fresh', () => {
            const {store, api} = setup();
            store.loadStock('c1');
            settle(api.stockPending, 0, [row('a')]);

            expect(store.stockLoaded('c1')).toBe(true);
        });

        it('supersedes an invalidateAll the same way', () => {
            const {store, api} = setup();
            store.loadStock('c1');
            store.invalidateAllStock();
            settle(api.stockPending, 0, [row('a')]);

            expect(store.stockLoaded('c1')).toBe(false);
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

    describe('named entity collections', () => {
        it('reads and writes the collection it was pointed at', () => {
            const {store, api} = setupNamed();
            store.loadStock('c1');
            settle(api.stockPending, 0, [row('a', 'Butter')]);

            expect(
                store
                    .stockFor('c1')()
                    .map(r => r.name),
            ).toEqual(['Butter']);
            expect(store.rowEntityMap()['a']).toBeDefined();
            expect(store.tagEntityMap()['a']).toBeUndefined();
        });

        it('keeps two row types apart under the same id', () => {
            const {store, api} = setupNamed();
            store.loadStock('c1');
            settle(api.stockPending, 0, [row('shared', 'Butter')]);
            store.loadTags('c1');
            api.tagPending[0].next([tag('shared', 'Dairy')]);
            api.tagPending[0].complete();

            expect(store.stockFor('c1')()[0].name).toBe('Butter');
            expect(store.tagsFor('c1')()[0].label).toBe('Dairy');
        });

        it('attaches and detaches against the named map', () => {
            const {store} = setupNamed();
            store.applyStock('c1', [row('a')]);
            store.attachToStock('c1', row('b'));
            store.detachFromStock('c1', 'a');

            expect(
                store
                    .stockFor('c1')()
                    .map(r => r.id),
            ).toEqual(['b']);
            expect(store.rowEntityMap()['a']).toBeDefined();
        });
    });

    describe('rows and onLoaded', () => {
        it('takes the rows out of a response that is not the rows', () => {
            const {store, api} = setupMeta();
            store.loadStock('c1');
            api.pagePending[0].next(page([row('a'), row('b')], null, 42));

            expect(
                store
                    .stockFor('c1')()
                    .map(r => r.id),
            ).toEqual(['a', 'b']);
            expect(store.totalByKey()['c1']).toBe(42);
        });

        it('lands the sibling patch in the same write as the rows', () => {
            const {store, api} = setupMeta();
            const seen: [number, number | undefined][] = [];
            TestBed.runInInjectionContext(() => {
                watchState(store, state =>
                    seen.push([state.stockIds['c1']?.length ?? 0, state.totalByKey['c1']]),
                );
            });

            store.loadStock('c1');
            api.pagePending[0].next(page([row('a'), row('b')], null, 42));

            // Neither half is ever visible without the other: the rows and the total move together.
            expect(seen).toContainEqual([2, 42]);
            expect(seen).not.toContainEqual([2, undefined]);
            expect(seen).not.toContainEqual([0, 42]);
        });

        it('leaves the sibling state alone on a failure', () => {
            const {store, api} = setupMeta();
            store.loadStock('c1');
            api.pagePending[0].next(page([row('a')], null, 7));
            store.loadStock('c1', {force: true});
            api.pagePending[1].error(new HttpErrorResponse({status: 500}));

            expect(store.totalByKey()['c1']).toBe(7);
            expect(store.stockError('c1')).toBe('failed');
        });

        it('treats the response as the rows when no reader is configured', () => {
            const {store, api} = setup();
            store.loadStock('c1');
            settle(api.stockPending, 0, [row('a')]);

            expect(
                store
                    .stockFor('c1')()
                    .map(r => r.id),
            ).toEqual(['a']);
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

    describe('insertAt', () => {
        it('appends by default', () => {
            const {store} = setup();
            store.applyStock('c1', [row('a')]);
            store.attachToStock('c1', row('b'));
            store.attachToStock('c1', row('c'));

            expect(store.stockIds()['c1']).toEqual(['a', 'b', 'c']);
        });

        it('prepends when the index asks for it', () => {
            const {store} = setupPaged();
            store.applyStock('c1', [row('a')]);
            store.attachToStock('c1', row('b'));
            store.attachToStock('c1', row('c'));

            expect(store.stockIds()['c1']).toEqual(['c', 'b', 'a']);
        });

        it('leaves a held id where it stands and still updates the row', () => {
            const {store} = setupPaged();
            store.applyStock('c1', [row('a'), row('b')]);
            store.attachToStock('c1', row('b', 'Zed'));

            expect(store.stockIds()['c1']).toEqual(['a', 'b']);
            expect(store.entityMap()['b'].name).toBe('Zed');
        });

        it('creates the key when nothing held it', () => {
            const {store} = setupPaged();
            store.attachToStock('c1', row('a'));

            expect(store.stockIds()['c1']).toEqual(['a']);
        });
    });

    describe('paging', () => {
        it('asks for the page with the cursor the response handed back', () => {
            const {store, api} = setupPaged();
            store.loadStock('c1');
            api.pagePending[0].next(page([row('b')], 'cur1'));
            expect(store.stockCursor('c1')).toBe('cur1');

            store.loadMoreStock('c1');

            expect(api.afterCalls).toEqual(['cur1']);
            expect(store.stockLoadingMore('c1')).toBe(true);
        });

        it('lands the page behind the first and moves the cursor on', () => {
            const {store, api} = setupPaged();
            store.loadStock('c1');
            api.pagePending[0].next(page([row('b')], 'cur1'));
            store.loadMoreStock('c1');
            api.afterPending[0].next(page([row('a')], null));

            expect(store.stockIds()['c1']).toEqual(['b', 'a']);
            expect(store.stockCursor('c1')).toBeNull();
            expect(store.stockLoadingMore('c1')).toBe(false);
        });

        it('leaves a row the key already holds alone', () => {
            const {store, api} = setupPaged();
            store.loadStock('c1');
            api.pagePending[0].next(page([row('b', 'Fresh')], 'cur1'));
            store.loadMoreStock('c1');
            api.afterPending[0].next(page([row('b', 'Stale'), row('a')], null));

            expect(store.entityMap()['b'].name).toBe('Fresh');
            expect(store.stockIds()['c1']).toEqual(['b', 'a']);
        });

        it('does nothing with no cursor', () => {
            const {store, api} = setupPaged();
            store.loadStock('c1');
            api.pagePending[0].next(page([row('b')], null));
            store.loadMoreStock('c1');

            expect(api.afterCalls).toEqual([]);
        });

        it('does nothing with a page already out', () => {
            const {store, api} = setupPaged();
            store.loadStock('c1');
            api.pagePending[0].next(page([row('b')], 'cur1'));
            store.loadMoreStock('c1');
            store.loadMoreStock('c1');

            expect(api.afterCalls).toEqual(['cur1']);
        });

        it('does nothing while a first-page load is running', () => {
            const {store, api} = setupPaged();
            store.loadStock('c1');
            api.pagePending[0].next(page([row('b')], 'cur1'));
            store.loadStock('c1', {force: true});
            store.loadMoreStock('c1');

            expect(api.afterCalls).toEqual([]);
        });

        it('does nothing for a key nobody fetched', () => {
            const {store, api} = setupPaged();
            store.loadMoreStock('c1');

            expect(api.afterCalls).toEqual([]);
            expect(store.stockTracked('c1')).toBe(false);
        });

        it('leaves loadedAt, stale and error alone when a page fails', () => {
            const {store, api} = setupPaged();
            store.loadStock('c1');
            api.pagePending[0].next(page([row('b')], 'cur1'));
            store.loadMoreStock('c1');
            api.afterPending[0].error(new HttpErrorResponse({status: 500}));

            expect(store.stockLoaded('c1')).toBe(true);
            expect(store.stockError('c1')).toBeNull();
            expect(store.stockCursor('c1')).toBe('cur1');
            expect(store.stockLoadingMore('c1')).toBe(false);
            expect(store.stockIds()['c1']).toEqual(['b']);
        });

        it('drops a page whose cursor moved while it was out', () => {
            const {store, api} = setupPaged();
            store.loadStock('c1');
            api.pagePending[0].next(page([row('b')], 'cur1'));
            store.loadMoreStock('c1');

            store.loadStock('c1', {force: true});
            api.pagePending[1].next(page([row('b')], 'cur_fresh'));
            api.afterPending[0].next(page([row('a')], 'cur2'));

            expect(store.stockIds()['c1']).toEqual(['b']);
            expect(store.stockCursor('c1')).toBe('cur_fresh');
            expect(store.stockLoadingMore('c1')).toBe(false);
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
