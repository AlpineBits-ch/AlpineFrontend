import {TestBed} from '@angular/core/testing';
import {patchState, signalStore, type} from '@ngrx/signals';
import {setAllEntities, withEntities} from '@ngrx/signals/entities';
import {unprotected} from '@ngrx/signals/testing';
import {withOptimisticEntities} from './with-optimistic-entities';

interface Row {
    id: string;
    text: string;
    checked: boolean;
}

function row(id: string, overrides: Partial<Row> = {}): Row {
    return {id, text: id, checked: false, ...overrides};
}

const TestStore = signalStore({providedIn: 'root'}, withEntities<Row>(), withOptimisticEntities<Row>());

function setup(rows: Row[] = [row('a')]) {
    TestBed.configureTestingModule({});
    const store = TestBed.inject(TestStore);
    patchState(unprotected(store), setAllEntities(rows));
    return store;
}

// A second collection on the same store, standing in for a store that (like `DiscoveryStore`) has
// two entity shapes and reaches this feature twice under different names.
const NamedTestStore = signalStore(
    {providedIn: 'root'},
    withEntities<Row, 'thing'>({entity: type<Row>(), collection: 'thing'}),
    withOptimisticEntities<Row, 'thing'>('thing'),
);

function setupNamed(rows: Row[] = [row('a')]) {
    TestBed.configureTestingModule({});
    const store = TestBed.inject(NamedTestStore);
    patchState(unprotected(store), setAllEntities(rows, {collection: 'thing'}));
    return store;
}

describe('withOptimisticEntities', () => {
    it('applies the change at once and undoes exactly the fields it touched', () => {
        const store = setup([row('a', {text: 'Milk', checked: false})]);

        const write = store.optimistic('a', {checked: true});
        expect(store.entityMap()['a'].checked).toBe(true);

        write.rollback();
        expect(store.entityMap()['a'].checked).toBe(false);
        expect(store.entityMap()['a'].text).toBe('Milk');
    });

    it('hands back an inert undo for an id it does not hold', () => {
        const store = setup();
        expect(() => store.optimistic('ghost', {checked: true}).rollback()).not.toThrow();
    });

    it('lets the newest write win when two rollbacks race', () => {
        const store = setup([row('a', {checked: false})]);

        const first = store.optimistic('a', {checked: true});
        const second = store.optimistic('a', {checked: false});

        // The first request fails last. Its rollback would put the row back to ticked, which is
        // not what was asked for most recently.
        first.rollback();
        expect(store.entityMap()['a'].checked).toBe(false);

        second.rollback();
        expect(store.entityMap()['a'].checked).toBe(true);
    });

    it('discards a settled response issued under a superseded generation', () => {
        const store = setup([row('a', {text: 'Milk', checked: false})]);

        const first = store.optimistic('a', {checked: true});
        store.optimistic('a', {checked: false});
        first.settle(row('a', {text: 'Stale', checked: true}));

        expect(store.entityMap()['a'].text).toBe('Milk');
        expect(store.entityMap()['a'].checked).toBe(false);
    });

    it('applies a settled response still on the current generation', () => {
        const store = setup([row('a', {text: 'Milk'})]);

        const write = store.optimistic('a', {checked: true});
        write.settle(row('a', {text: 'Oat milk', checked: true}));

        expect(store.entityMap()['a'].text).toBe('Oat milk');
    });

    it('is superseded by a bare generation bump, which is how a realtime echo cancels a response', () => {
        const store = setup([row('a', {text: 'Milk'})]);

        const write = store.optimistic('a', {checked: true});
        store.bumpGeneration('a');
        write.settle(row('a', {text: 'Stale'}));

        expect(store.entityMap()['a'].text).toBe('Milk');
    });

    it('counts generations per entity, so one row does not stale another', () => {
        const store = setup([row('a'), row('b')]);

        const generationA = store.bumpGeneration('a');
        store.bumpGeneration('b');
        store.bumpGeneration('b');

        expect(store.isCurrentGeneration('a', generationA)).toBe(true);
        expect(store.isCurrentGeneration('b', generationA)).toBe(false);
    });

    // A named collection composes under `optimisticThing`/`bumpGenerationThing`/
    // `isCurrentGenerationThing` rather than `optimistic`/`bumpGeneration`/`isCurrentGeneration`, so a
    // store with two entity shapes can reach this feature twice without the second call silently
    // overwriting the first's members.
    describe('named collection', () => {
        it('applies and settles a write against the named collection', () => {
            const store = setupNamed([row('a', {text: 'Milk', checked: false})]);

            const write = store.optimisticThing('a', {checked: true});
            expect(store.thingEntityMap()['a'].checked).toBe(true);

            write.settle(row('a', {text: 'Oat milk', checked: true}));
            expect(store.thingEntityMap()['a'].text).toBe('Oat milk');
        });

        it('rolls a named-collection write back to exactly the fields it touched', () => {
            const store = setupNamed([row('a', {text: 'Milk', checked: false})]);

            const write = store.optimisticThing('a', {checked: true});
            write.rollback();

            expect(store.thingEntityMap()['a'].checked).toBe(false);
            expect(store.thingEntityMap()['a'].text).toBe('Milk');
        });

        it('loses a stale settle to a newer generation, on the named collection', () => {
            const store = setupNamed([row('a', {text: 'Milk', checked: false})]);

            const first = store.optimisticThing('a', {checked: true});
            // Something else - a realtime refetch, a second write - bumps the generation before the
            // first request settles.
            store.bumpGenerationThing('a');
            first.settle(row('a', {text: 'Stale', checked: true}));

            // The settle lost, so the response's `text` never lands - the field the first write
            // touched itself is untouched by this, matching `optimistic`'s own bare-bump spec above.
            expect(store.thingEntityMap()['a'].text).toBe('Milk');
        });
    });
});
