import {TestBed} from '@angular/core/testing';
import {patchState, signalStore} from '@ngrx/signals';
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

describe('withOptimisticEntities', () => {
    it('applies the change at once and undoes exactly the fields it touched', () => {
        const store = setup([row('a', {text: 'Milk', checked: false})]);

        const rollback = store.optimistic('a', {checked: true});
        expect(store.entityMap()['a'].checked).toBe(true);

        rollback();
        expect(store.entityMap()['a'].checked).toBe(false);
        expect(store.entityMap()['a'].text).toBe('Milk');
    });

    it('hands back an inert undo for an id it does not hold', () => {
        const store = setup();
        expect(() => store.optimistic('ghost', {checked: true})()).not.toThrow();
    });

    it('lets the newest write win when two rollbacks race', () => {
        const store = setup([row('a', {checked: false})]);

        const undoFirst = store.optimistic('a', {checked: true});
        const undoSecond = store.optimistic('a', {checked: false});

        // The first request fails last. Its rollback would put the row back to ticked, which is
        // not what was asked for most recently.
        undoFirst();
        expect(store.entityMap()['a'].checked).toBe(false);

        undoSecond();
        expect(store.entityMap()['a'].checked).toBe(true);
    });

    it('discards a settled response issued under a superseded generation', () => {
        const store = setup([row('a', {text: 'Milk'})]);

        const generation = store.bumpGeneration('a');
        store.bumpGeneration('a');
        store.settleEntity('a', generation, row('a', {text: 'Stale'}));

        expect(store.entityMap()['a'].text).toBe('Milk');
    });

    it('applies a settled response still on the current generation', () => {
        const store = setup([row('a', {text: 'Milk'})]);

        const generation = store.bumpGeneration('a');
        store.settleEntity('a', generation, row('a', {text: 'Oat milk'}));

        expect(store.entityMap()['a'].text).toBe('Oat milk');
    });

    it('counts generations per entity, so one row does not stale another', () => {
        const store = setup([row('a'), row('b')]);

        const generationA = store.bumpGeneration('a');
        store.bumpGeneration('b');
        store.bumpGeneration('b');

        expect(store.isCurrentGeneration('a', generationA)).toBe(true);
        expect(store.isCurrentGeneration('b', generationA)).toBe(false);
    });
});
