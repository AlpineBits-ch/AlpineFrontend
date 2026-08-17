import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting, TestRequest} from '@angular/common/http/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';

import {ListService} from './list.service';
import {ApiConfigService} from './api-config.service';
import {ProfileService} from './profile.service';
import {RealtimeConnectionService} from './realtime-connection.service';
import {ListItem, reorderByPartialIds, validateNewListItem} from '../dtos/response/list.dto';

const base = 'https://api.test.example/api/v1/guild';
const CHANNEL = 'c1';
const GUILD = 'g1';

function itemFixture(id: string, overrides: Partial<ListItem> = {}): ListItem {
    return {
        id,
        channelId: CHANNEL,
        text: id,
        quantity: null,
        note: null,
        section: null,
        assigneeUserId: null,
        addedByUserId: 'u1',
        isChecked: false,
        checkedAt: null,
        checkedByUserId: null,
        position: 0,
        sourcePantryItemId: null,
        createdAt: '2026-08-03T00:00:00Z',
        ...overrides,
    };
}

/** Captures the handlers registered in the constructor so the spec can push events at them. */
class FakeRealtime {
    readonly handlers = new Map<string, ((payload: unknown) => void)[]>();

    on(event: string, handler: (payload: unknown) => void): void {
        const existing = this.handlers.get(event) ?? [];
        existing.push(handler);
        this.handlers.set(event, existing);
    }

    emit(event: string, payload: unknown): void {
        for (const handler of this.handlers.get(event) ?? []) handler(payload);
    }

    /** How many handlers a name got - registering twice would deliver every event twice. */
    countFor(event: string): number {
        return (this.handlers.get(event) ?? []).length;
    }
}

function setup() {
    const realtime = new FakeRealtime();
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            provideTranslateService({defaultLanguage: 'en'}),
            MessageService,
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            {provide: RealtimeConnectionService, useValue: realtime},
            {provide: ProfileService, useValue: {ownProfile: () => ({userId: 'me'})}},
        ],
    });
    return {
        service: TestBed.inject(ListService),
        ctrl: TestBed.inject(HttpTestingController),
        realtime,
    };
}

/** Loads a channel with the given rows, leaving the service in the "tracked and loaded" state. */
function loadWith(service: ListService, ctrl: HttpTestingController, items: ListItem[]): void {
    service.reload(CHANNEL);
    ctrl.expectOne(r => r.url === `${base}/channels/${CHANNEL}/list-items`).flush(items);
}

function ids(service: ListService): string[] {
    return service.stateFor(CHANNEL).items.map(item => item.id);
}

function scope(extra: Record<string, unknown>) {
    return {guildId: GUILD, channelId: CHANNEL, ...extra};
}

describe('reorderByPartialIds', () => {
    const rows = [{id: 'a'}, {id: 'b'}, {id: 'c'}, {id: 'd'}];

    it('places the ids sent first, in the order given', () => {
        expect(reorderByPartialIds(rows, ['c', 'a']).map(r => r.id)).toEqual(['c', 'a', 'b', 'd']);
    });

    it('keeps omitted ids in their relative order after the ones sent', () => {
        expect(reorderByPartialIds(rows, ['d']).map(r => r.id)).toEqual(['d', 'a', 'b', 'c']);
    });

    it('skips ids it does not hold rather than dropping the rest', () => {
        expect(reorderByPartialIds(rows, ['ghost', 'b']).map(r => r.id)).toEqual(['b', 'a', 'c', 'd']);
    });

    it('is a no-op for the full list in its current order', () => {
        expect(reorderByPartialIds(rows, ['a', 'b', 'c', 'd']).map(r => r.id)).toEqual(['a', 'b', 'c', 'd']);
    });
});

describe('validateNewListItem', () => {
    it('rejects blank text', () => {
        expect(validateNewListItem('   ', 0)).toBe('EMPTY');
    });

    it('rejects text past 200 chars', () => {
        expect(validateNewListItem('x'.repeat(201), 0)).toBe('TEXT_TOO_LONG');
        expect(validateNewListItem('x'.repeat(200), 0)).toBe(null);
    });

    it('rejects the 501st row, counting checked ones too', () => {
        expect(validateNewListItem('milk', 500)).toBe('LIST_FULL');
        expect(validateNewListItem('milk', 499)).toBe(null);
    });
});

describe('ListService realtime reconciliation', () => {
    let service: ListService;
    let ctrl: HttpTestingController;
    let realtime: FakeRealtime;

    beforeEach(() => {
        ({service, ctrl, realtime} = setup());
    });

    afterEach(() => ctrl.verify());

    it('registers each of the six events exactly once', () => {
        for (const event of [
            'guild.ListItemCreated',
            'guild.ListItemUpdated',
            'guild.ListItemChecked',
            'guild.ListItemDeleted',
            'guild.ListItemsReordered',
            'guild.ListCleared',
        ]) {
            expect(realtime.countFor(event), event).toBe(1);
        }
    });

    it('ignores every event for a channel that was never fetched', () => {
        realtime.emit('guild.ListItemCreated', scope({item: itemFixture('a')}));
        realtime.emit('guild.ListItemsReordered', scope({itemIds: ['a']}));
        realtime.emit('guild.ListCleared', scope({removedCount: 3}));

        expect(service.stateFor(CHANNEL).items).toEqual([]);
        expect(service.stateFor(CHANNEL).hasLoaded).toBe(false);
    });

    it('sorts the loaded list by position and renumbers it to the index', () => {
        loadWith(service, ctrl, [itemFixture('b', {position: 7}), itemFixture('a', {position: 2})]);

        expect(ids(service)).toEqual(['a', 'b']);
        expect(service.stateFor(CHANNEL).items.map(i => i.position)).toEqual([0, 1]);
    });

    it('appends a created row', () => {
        loadWith(service, ctrl, [itemFixture('a')]);
        realtime.emit('guild.ListItemCreated', scope({item: itemFixture('b')}));

        expect(ids(service)).toEqual(['a', 'b']);
    });

    it('fills in the fields the pantry variant of ListItemCreated omits', () => {
        loadWith(service, ctrl, []);
        // PantryRestockService emits an anonymous object, not a full ListItemDto: no
        // addedByUserId and no createdAt.
        realtime.emit(
            'guild.ListItemCreated',
            scope({
                item: {
                    id: 'oat-milk',
                    channelId: CHANNEL,
                    text: 'Oat milk',
                    quantity: '2',
                    section: 'Dairy',
                    position: 0,
                    sourcePantryItemId: 'p9',
                    isChecked: false,
                },
            }),
        );

        const [item] = service.stateFor(CHANNEL).items;
        expect(item.sourcePantryItemId).toBe('p9');
        // Empty, never undefined: it is compared against the viewer's id to decide "may I edit
        // this", and undefined === undefined would hand a pantry row to anyone with no profile.
        expect(item.addedByUserId).toBe('');
        expect(typeof item.createdAt).toBe('string');
    });

    it('does not duplicate a created row it already holds', () => {
        loadWith(service, ctrl, [itemFixture('a', {text: 'Milk'})]);
        realtime.emit('guild.ListItemCreated', scope({item: itemFixture('a', {text: 'Whole milk'})}));

        expect(ids(service)).toEqual(['a']);
        expect(service.stateFor(CHANNEL).items[0].text).toBe('Whole milk');
    });

    it('applies an update in place without moving the row', () => {
        loadWith(service, ctrl, [itemFixture('a'), itemFixture('b')]);
        realtime.emit('guild.ListItemUpdated', scope({item: itemFixture('a', {text: 'Bread'})}));

        expect(ids(service)).toEqual(['a', 'b']);
        expect(service.stateFor(CHANNEL).items[0].text).toBe('Bread');
    });

    it('ignores an update for a row it does not hold', () => {
        loadWith(service, ctrl, [itemFixture('a')]);
        realtime.emit('guild.ListItemUpdated', scope({item: itemFixture('ghost')}));

        expect(ids(service)).toEqual(['a']);
    });

    it('assigns isChecked from the event rather than flipping it', () => {
        loadWith(service, ctrl, [itemFixture('a', {isChecked: true})]);

        // The same "checked" event twice - which is what a redelivery looks like. A handler that
        // toggled would land on false and un-strike a row nobody unticked.
        const checked = itemFixture('a', {isChecked: true, checkedByUserId: 'flatmate'});
        realtime.emit('guild.ListItemChecked', scope({item: checked}));
        realtime.emit('guild.ListItemChecked', scope({item: checked}));

        expect(service.stateFor(CHANNEL).items[0].isChecked).toBe(true);
        expect(service.stateFor(CHANNEL).items[0].checkedByUserId).toBe('flatmate');
    });

    it('unticks on a ListItemChecked carrying isChecked false', () => {
        loadWith(service, ctrl, [itemFixture('a', {isChecked: true, checkedByUserId: 'flatmate'})]);
        realtime.emit(
            'guild.ListItemChecked',
            scope({
                item: itemFixture('a', {isChecked: false, checkedAt: null, checkedByUserId: null}),
            }),
        );

        expect(service.stateFor(CHANNEL).items[0].isChecked).toBe(false);
    });

    it('removes a deleted row', () => {
        loadWith(service, ctrl, [itemFixture('a'), itemFixture('b')]);
        realtime.emit('guild.ListItemDeleted', scope({itemId: 'a'}));

        expect(ids(service)).toEqual(['b']);
    });

    it('applies a partial reorder echo with omitted ids trailing', () => {
        loadWith(
            service,
            ctrl,
            ['a', 'b', 'c', 'd'].map((id, i) => itemFixture(id, {position: i})),
        );
        realtime.emit('guild.ListItemsReordered', scope({itemIds: ['c', 'a']}));

        expect(ids(service)).toEqual(['c', 'a', 'b', 'd']);
        expect(service.stateFor(CHANNEL).items.map(i => i.position)).toEqual([0, 1, 2, 3]);
    });

    it('clears by the checked set, not by the broadcast count', () => {
        loadWith(service, ctrl, [
            itemFixture('a', {isChecked: true}),
            itemFixture('b'),
            itemFixture('c', {isChecked: true}),
        ]);
        // A count that disagrees with what this client holds must not decide which rows go.
        realtime.emit('guild.ListCleared', scope({removedCount: 99}));

        expect(ids(service)).toEqual(['b']);
    });
});

describe('ListService optimism', () => {
    let service: ListService;
    let ctrl: HttpTestingController;
    let realtime: FakeRealtime;

    beforeEach(() => {
        ({service, ctrl, realtime} = setup());
    });

    afterEach(() => ctrl.verify());

    function expectCreate(): TestRequest {
        return ctrl.expectOne(r => r.method === 'POST' && r.url === `${base}/channels/${CHANNEL}/list-items`);
    }

    it('shows a new row before the server answers, then swaps in the server row', async () => {
        loadWith(service, ctrl, []);

        const pending = service.addItem(CHANNEL, {text: 'Milk', quantity: '2 packs'});
        expect(service.stateFor(CHANNEL).items.length).toBe(1);
        expect(service.stateFor(CHANNEL).items[0].text).toBe('Milk');

        expectCreate().flush(itemFixture('server-1', {text: 'Milk', quantity: '2 packs'}));
        await pending;

        expect(ids(service)).toEqual(['server-1']);
    });

    it('sends quantity verbatim rather than parsing a number out of it', async () => {
        loadWith(service, ctrl, []);

        const pending = service.addItem(CHANNEL, {text: 'Bananas', quantity: 'a bunch'});
        const req = expectCreate();
        expect(req.request.body.quantity).toBe('a bunch');

        req.flush(itemFixture('server-1', {quantity: 'a bunch'}));
        await pending;
        expect(service.stateFor(CHANNEL).items[0].quantity).toBe('a bunch');
    });

    it('clears a quantity with an empty string, which is the only thing the PATCH honours', async () => {
        // `quantity: null` would be read server-side as "leave it alone" - the request would
        // succeed and the row would keep its old "2 packs".
        loadWith(service, ctrl, [itemFixture('a', {quantity: '2 packs'})]);

        const pending = service.updateItem(CHANNEL, 'a', {text: 'Milk', quantity: ''});
        const req = ctrl.expectOne(r => r.method === 'PATCH' && r.url === `${base}/list-items/a`);
        expect(req.request.body).toEqual({text: 'Milk', quantity: ''});

        req.flush(itemFixture('a', {text: 'Milk', quantity: ''}));
        await pending;
        expect(service.stateFor(CHANNEL).items[0].quantity).toBe('');
    });

    it('translates clearAssignee into a null assignee locally instead of spreading the flag', async () => {
        loadWith(service, ctrl, [itemFixture('a', {assigneeUserId: 'u2'})]);

        const pending = service.updateItem(CHANNEL, 'a', {clearAssignee: true});
        // The optimistic row is unassigned before the response, and carries no wire flag.
        const optimistic = service.stateFor(CHANNEL).items[0] as ListItem & {clearAssignee?: boolean};
        expect(optimistic.assigneeUserId).toBeNull();
        expect(optimistic.clearAssignee).toBeUndefined();

        const req = ctrl.expectOne(r => r.method === 'PATCH' && r.url === `${base}/list-items/a`);
        expect(req.request.body).toEqual({clearAssignee: true});
        req.flush(itemFixture('a', {assigneeUserId: null}));
        await pending;
    });

    it('rolls the optimistic row back when the create fails', async () => {
        loadWith(service, ctrl, [itemFixture('a')]);

        const pending = service.addItem(CHANNEL, {text: 'Milk'});
        expect(service.stateFor(CHANNEL).items.length).toBe(2);

        expectCreate().flush('nope', {status: 500, statusText: 'Server Error'});
        expect(await pending).toBe(false);
        expect(ids(service)).toEqual(['a']);
    });

    it('does not duplicate when the created broadcast beats the create response', async () => {
        loadWith(service, ctrl, []);

        const pending = service.addItem(CHANNEL, {text: 'Milk'});
        const req = expectCreate();

        // The broadcast lands first, carrying the real row.
        realtime.emit('guild.ListItemCreated', scope({item: itemFixture('server-1', {text: 'Milk'})}));
        req.flush(itemFixture('server-1', {text: 'Milk'}));
        await pending;

        expect(ids(service)).toEqual(['server-1']);
    });

    it('refuses text past the cap without issuing a request', async () => {
        loadWith(service, ctrl, []);

        expect(await service.addItem(CHANNEL, {text: 'x'.repeat(201)})).toBe(false);
        expect(service.stateFor(CHANNEL).items).toEqual([]);
        // ctrl.verify() in afterEach is what asserts no request went out.
    });

    it('refuses the 501st row without issuing a request', async () => {
        loadWith(
            service,
            ctrl,
            Array.from({length: 500}, (_, i) => itemFixture(`i${i}`, {position: i})),
        );

        expect(await service.addItem(CHANNEL, {text: 'One too many'})).toBe(false);
        expect(service.stateFor(CHANNEL).items.length).toBe(500);
    });

    it('strikes a row through immediately and keeps it struck through on the echo', async () => {
        loadWith(service, ctrl, [itemFixture('a')]);

        const pending = service.setChecked(CHANNEL, 'a', true);
        expect(service.stateFor(CHANNEL).items[0].isChecked).toBe(true);
        expect(service.stateFor(CHANNEL).items[0].checkedByUserId).toBe('me');

        const req = ctrl.expectOne(r => r.method === 'POST' && r.url === `${base}/list-items/a/check`);
        req.flush(itemFixture('a', {isChecked: true, checkedByUserId: 'me'}));
        await pending;

        realtime.emit(
            'guild.ListItemChecked',
            scope({
                item: itemFixture('a', {isChecked: true, checkedByUserId: 'me'}),
            }),
        );

        // Optimistic tick, then the response, then the echo - three touches, one state.
        expect(service.stateFor(CHANNEL).items[0].isChecked).toBe(true);
    });

    it('treats re-ticking an already-ticked row as a no-op success, not an error', async () => {
        loadWith(service, ctrl, [itemFixture('a', {isChecked: true})]);

        // The route is idempotent server-side; skipping it here is the saved round trip, and the
        // reason a repeat has no failure path at all.
        expect(await service.setChecked(CHANNEL, 'a', true)).toBe(true);
        expect(service.stateFor(CHANNEL).items[0].isChecked).toBe(true);
    });

    it('rolls a failed tick back to the exact row it replaced', async () => {
        loadWith(service, ctrl, [itemFixture('a', {isChecked: false, text: 'Milk'})]);

        const pending = service.setChecked(CHANNEL, 'a', true);
        ctrl.expectOne(r => r.url === `${base}/list-items/a/check`).flush('nope', {
            status: 500,
            statusText: 'Server Error',
        });

        expect(await pending).toBe(false);
        expect(service.stateFor(CHANNEL).items[0].isChecked).toBe(false);
        expect(service.stateFor(CHANNEL).items[0].text).toBe('Milk');
    });

    it('untick uses DELETE on the same route and clears the checked-by fields', async () => {
        loadWith(service, ctrl, [itemFixture('a', {isChecked: true, checkedByUserId: 'flatmate'})]);

        const pending = service.setChecked(CHANNEL, 'a', false);
        expect(service.stateFor(CHANNEL).items[0].checkedByUserId).toBe(null);

        ctrl.expectOne(r => r.method === 'DELETE' && r.url === `${base}/list-items/a/check`).flush(
            itemFixture('a', {isChecked: false}),
        );
        await pending;

        expect(service.stateFor(CHANNEL).items[0].isChecked).toBe(false);
    });

    it('lets the newest tick win when two responses land out of order', async () => {
        loadWith(service, ctrl, [itemFixture('a')]);

        const first = service.setChecked(CHANNEL, 'a', true);
        const checkReq = ctrl.expectOne(r => r.method === 'POST' && r.url === `${base}/list-items/a/check`);

        const second = service.setChecked(CHANNEL, 'a', false);
        const uncheckReq = ctrl.expectOne(
            r => r.method === 'DELETE' && r.url === `${base}/list-items/a/check`,
        );

        // The untick answers first, the stale tick second.
        uncheckReq.flush(itemFixture('a', {isChecked: false}));
        checkReq.flush(itemFixture('a', {isChecked: true}));
        await Promise.all([first, second]);

        expect(service.stateFor(CHANNEL).items[0].isChecked).toBe(false);
    });

    it('restores a failed delete at its original index', async () => {
        loadWith(
            service,
            ctrl,
            ['a', 'b', 'c'].map((id, i) => itemFixture(id, {position: i})),
        );

        const pending = service.deleteItem(CHANNEL, 'b');
        expect(ids(service)).toEqual(['a', 'c']);

        ctrl.expectOne(r => r.method === 'DELETE' && r.url === `${base}/list-items/b`).flush('nope', {
            status: 500,
            statusText: 'Server Error',
        });

        expect(await pending).toBe(false);
        expect(ids(service)).toEqual(['a', 'b', 'c']);
    });

    it('sends only the affected prefix on a drag, and reorders locally at once', async () => {
        loadWith(
            service,
            ctrl,
            ['a', 'b', 'c', 'd', 'e'].map((id, i) => itemFixture(id, {position: i})),
        );

        const pending = service.moveItem(CHANNEL, 1, 2);
        expect(ids(service)).toEqual(['a', 'c', 'b', 'd', 'e']);

        const req = ctrl.expectOne(
            r => r.method === 'POST' && r.url === `${base}/channels/${CHANNEL}/list-items/reorder`,
        );
        // Down to the further of the two indices and no further: everything below it kept its
        // relative order, and omitted ids trail the ones sent anyway.
        expect(req.request.body.itemIds).toEqual(['a', 'c', 'b']);

        req.flush(null);
        expect(await pending).toBe(true);
    });

    it('restores the previous order when the reorder fails', async () => {
        loadWith(
            service,
            ctrl,
            ['a', 'b', 'c'].map((id, i) => itemFixture(id, {position: i})),
        );

        const pending = service.moveItem(CHANNEL, 2, 0);
        expect(ids(service)).toEqual(['c', 'a', 'b']);

        ctrl.expectOne(r => r.url === `${base}/channels/${CHANNEL}/list-items/reorder`).flush('nope', {
            status: 500,
            statusText: 'Server Error',
        });

        expect(await pending).toBe(false);
        expect(ids(service)).toEqual(['a', 'b', 'c']);
    });

    it('keeps a row created during a failed reorder', async () => {
        loadWith(
            service,
            ctrl,
            ['a', 'b'].map((id, i) => itemFixture(id, {position: i})),
        );

        const pending = service.moveItem(CHANNEL, 1, 0);
        realtime.emit('guild.ListItemCreated', scope({item: itemFixture('late')}));

        ctrl.expectOne(r => r.url === `${base}/channels/${CHANNEL}/list-items/reorder`).flush('nope', {
            status: 500,
            statusText: 'Server Error',
        });
        await pending;

        expect(ids(service)).toEqual(['a', 'b', 'late']);
    });

    it('removes the checked rows on clear and puts them back when it fails', async () => {
        loadWith(service, ctrl, [
            itemFixture('a', {isChecked: true, position: 0}),
            itemFixture('b', {position: 1}),
        ]);

        const pending = service.clearChecked(CHANNEL);
        expect(ids(service)).toEqual(['b']);

        ctrl.expectOne(
            r => r.method === 'DELETE' && r.url === `${base}/channels/${CHANNEL}/list-items/checked`,
        ).flush('nope', {status: 500, statusText: 'Server Error'});

        expect(await pending).toBe(false);
        expect(ids(service)).toEqual(['a', 'b']);
    });

    it('records a 403 separately from a network failure so the caller can read features first', () => {
        service.reload(CHANNEL);
        ctrl.expectOne(r => r.url === `${base}/channels/${CHANNEL}/list-items`).flush('nope', {
            status: 403,
            statusText: 'Forbidden',
        });

        expect(service.stateFor(CHANNEL).forbidden).toBe(true);
        expect(service.stateFor(CHANNEL).hasLoaded).toBe(false);
    });

    it('fetches checked rows too - hiding them is a view filter, not a query', () => {
        service.reload(CHANNEL);
        const req = ctrl.expectOne(r => r.url === `${base}/channels/${CHANNEL}/list-items`);
        expect(req.request.params.get('includeChecked')).toBe('true');
        req.flush([]);
    });
});
