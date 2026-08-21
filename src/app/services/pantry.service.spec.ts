import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {Subject} from 'rxjs';
import {PantryService} from './pantry.service';
import {ApiConfigService} from './api-config.service';
import {RealtimeConnectionService} from './realtime-connection.service';
import {PantryItem, pantryStockState} from '../dtos/response/pantry.dto';

const BASE = 'https://api.test.example';
const GUILD = `${BASE}/api/v1/guild`;
const CHANNEL = 'chan_pantry';
const GUILD_ID = 'gild_1';

/** Streams the store subscribed to on the fake hub, so a test can fire a server event. */
let hubHandlers: Map<string, Subject<any>>;
/** Every registration in order, so the "registered exactly once" rule can be asserted. */
let registrations: string[];

function setup() {
    hubHandlers = new Map();
    registrations = [];

    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => BASE}},
            {
                provide: RealtimeConnectionService,
                useValue: {
                    stream: (event: string) => {
                        registrations.push(event);
                        const subject = new Subject<any>();
                        hubHandlers.set(event, subject);
                        return subject.asObservable();
                    },
                    off: () => undefined,
                },
            },
        ],
    });

    return {
        service: TestBed.inject(PantryService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

function item(overrides: Partial<PantryItem> = {}): PantryItem {
    return {
        id: 'pitm_1',
        channelId: CHANNEL,
        name: 'Milk',
        quantity: 4,
        unit: 'l',
        lowThreshold: 2,
        expiresAt: null,
        isLow: false,
        restockedAt: null,
        addedByUserId: 'user_1',
        ...overrides,
    };
}

/** Loads one pantry and answers both of `refresh`'s requests. */
function load(service: PantryService, ctrl: HttpTestingController, items: PantryItem[]) {
    service.loadFor(CHANNEL);
    ctrl.expectOne(`${GUILD}/channels/${CHANNEL}/pantry-items`).flush(items);
    ctrl.expectOne(`${GUILD}/channels/${CHANNEL}/pantry/config`).flush({
        channelId: CHANNEL,
        restockListChannelId: 'chan_list',
        expiryWarningDays: 3,
    });
}

function fire(event: string, payload: unknown) {
    const subject = hubHandlers.get(event);
    if (!subject) throw new Error(`no handler registered for ${event}`);
    subject.next(payload);
}

describe('PantryService', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    describe('realtime registration', () => {
        it('registers the three pantry item events exactly once each', () => {
            setup();
            expect(registrations).toEqual([
                'guild.PantryItemCreated',
                'guild.PantryItemUpdated',
                'guild.PantryItemDeleted',
            ]);
        });

        // The list-side event of an automatic restock belongs to the Lists module; picking
        // it up here as well would deliver every list item twice.
        it('does not register guild.ListItemCreated', () => {
            setup();
            expect(registrations).not.toContain('guild.ListItemCreated');
        });
    });

    describe('loading', () => {
        it('fetches items and config once per pantry however often loadFor is called', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [item()]);
            service.loadFor(CHANNEL);
            ctrl.expectNone(`${GUILD}/channels/${CHANNEL}/pantry-items`);
            expect(service.itemsFor(CHANNEL).length).toBe(1);
        });

        it('sorts by name so a quantity edit never reorders the list', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [item({id: 'b', name: 'Rice'}), item({id: 'a', name: 'Butter'})]);
            expect(service.itemsFor(CHANNEL).map(i => i.name)).toEqual(['Butter', 'Rice']);
        });

        it('keeps the pantry unloaded on a failed item fetch, so empty and refused stay distinct', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            ctrl.expectOne(`${GUILD}/channels/${CHANNEL}/pantry-items`).flush('nope', {
                status: 403,
                statusText: 'Forbidden',
            });
            ctrl.expectOne(`${GUILD}/channels/${CHANNEL}/pantry/config`).flush('nope', {
                status: 403,
                statusText: 'Forbidden',
            });

            expect(service.hasLoaded(CHANNEL)).toBe(false);
            expect(service.loadError(CHANNEL)).toBe(true);
            expect(service.loading(CHANNEL)).toBe(false);
        });

        it('still lists stock when only the config fetch fails', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            ctrl.expectOne(`${GUILD}/channels/${CHANNEL}/pantry-items`).flush([item()]);
            ctrl.expectOne(`${GUILD}/channels/${CHANNEL}/pantry/config`).flush('nope', {
                status: 500,
                statusText: 'Server Error',
            });

            expect(service.itemsFor(CHANNEL).length).toBe(1);
            expect(service.configFor(CHANNEL)).toBeUndefined();
        });
    });

    describe('realtime item events', () => {
        it('adds a created item to an open pantry', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, []);
            fire('guild.PantryItemCreated', {guildId: GUILD_ID, channelId: CHANNEL, item: item({id: 'new'})});
            expect(service.itemsFor(CHANNEL).map(i => i.id)).toEqual(['new']);
        });

        it('ignores events for a pantry nobody has opened rather than seeding a partial list', () => {
            const {service} = setup();
            fire('guild.PantryItemCreated', {guildId: GUILD_ID, channelId: 'chan_other', item: item()});
            expect(service.itemsFor('chan_other')).toEqual([]);
            expect(service.hasLoaded('chan_other')).toBe(false);
        });

        it('treats a re-delivered create as an upsert rather than a duplicate row', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [item()]);
            fire('guild.PantryItemCreated', {
                guildId: GUILD_ID,
                channelId: CHANNEL,
                item: item({quantity: 9}),
            });
            expect(service.itemsFor(CHANNEL).length).toBe(1);
            expect(service.itemsFor(CHANNEL)[0].quantity).toBe(9);
        });

        it('applies an update for a row it never saw created', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, []);
            fire('guild.PantryItemUpdated', {
                guildId: GUILD_ID,
                channelId: CHANNEL,
                item: item({id: 'late'}),
            });
            expect(service.itemsFor(CHANNEL).map(i => i.id)).toEqual(['late']);
        });

        it('removes a deleted row', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [item()]);
            fire('guild.PantryItemDeleted', {guildId: GUILD_ID, channelId: CHANNEL, itemId: 'pitm_1'});
            expect(service.itemsFor(CHANNEL)).toEqual([]);
        });
    });

    // The state machine itself is covered in pantry.dto.spec; what matters here is that a
    // release actually reaches the cache, because a store that merged payloads instead of
    // replacing them would latch the badge on forever.
    describe('the restock loop over the wire', () => {
        it('stamps and releases restockedAt as the server sends it', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [item({quantity: 4})]);
            const read = () => pantryStockState(service.itemsFor(CHANNEL)[0]);
            expect(read()).toBe('ok');

            fire('guild.PantryItemUpdated', {
                guildId: GUILD_ID,
                channelId: CHANNEL,
                item: item({quantity: 1, isLow: true, restockedAt: '2026-08-03T10:00:00Z'}),
            });
            expect(read()).toBe('listed');

            // Bought and put away: the server releases the stamp on the same row.
            fire('guild.PantryItemUpdated', {
                guildId: GUILD_ID,
                channelId: CHANNEL,
                item: item({quantity: 6, isLow: false, restockedAt: null}),
            });
            expect(read()).toBe('ok');
        });

        it('re-enters listed on a second cycle', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [item({quantity: 4})]);
            const push = (patch: Partial<PantryItem>) =>
                fire('guild.PantryItemUpdated', {
                    guildId: GUILD_ID,
                    channelId: CHANNEL,
                    item: item(patch),
                });

            push({quantity: 1, restockedAt: '2026-08-01T10:00:00Z'});
            push({quantity: 6, restockedAt: null});
            push({quantity: 1, restockedAt: '2026-08-09T10:00:00Z'});

            expect(pantryStockState(service.itemsFor(CHANNEL)[0])).toBe('listed');
        });

        it('keeps a null threshold null through an update', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [item({lowThreshold: 2})]);
            fire('guild.PantryItemUpdated', {
                guildId: GUILD_ID,
                channelId: CHANNEL,
                item: item({lowThreshold: null, quantity: 0}),
            });
            expect(service.itemsFor(CHANNEL)[0].lowThreshold).toBeNull();
            expect(pantryStockState(service.itemsFor(CHANNEL)[0])).toBe('untracked');
        });
    });

    describe('writes', () => {
        it('applies the server echo without waiting for the realtime event', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, []);

            service.addItem(CHANNEL, {name: 'Rice', quantity: 2, lowThreshold: 0}).subscribe();
            ctrl.expectOne(`${GUILD}/channels/${CHANNEL}/pantry-items`).flush(
                item({id: 'pitm_2', name: 'Rice', quantity: 2, lowThreshold: 0}),
            );

            expect(service.itemsFor(CHANNEL).map(i => i.id)).toEqual(['pitm_2']);
        });

        it('is idempotent when the echo event arrives after the write', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, []);

            service.addItem(CHANNEL, {name: 'Rice', quantity: 2}).subscribe();
            const created = item({id: 'pitm_2', name: 'Rice'});
            ctrl.expectOne(`${GUILD}/channels/${CHANNEL}/pantry-items`).flush(created);
            fire('guild.PantryItemCreated', {guildId: GUILD_ID, channelId: CHANNEL, item: created});

            expect(service.itemsFor(CHANNEL).length).toBe(1);
        });

        it('removes the row on a successful delete', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [item()]);
            service.deleteItem(CHANNEL, 'pitm_1').subscribe();
            ctrl.expectOne(`${GUILD}/pantry-items/pitm_1`).flush(null);
            expect(service.itemsFor(CHANNEL)).toEqual([]);
        });

        it('caches the config a save returns', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, []);
            service.saveConfig(CHANNEL, {clearRestockList: true, expiryWarningDays: 14}).subscribe();
            ctrl.expectOne(`${GUILD}/channels/${CHANNEL}/pantry/config`).flush({
                channelId: CHANNEL,
                restockListChannelId: null,
                expiryWarningDays: 14,
            });

            expect(service.configFor(CHANNEL)?.restockListChannelId).toBeNull();
            expect(service.configFor(CHANNEL)?.expiryWarningDays).toBe(14);
        });
    });

    describe('the guild-scoped expiring view', () => {
        const expiringUrl = `${GUILD}/guilds/${GUILD_ID}/pantry/expiring`;

        it('asks the guild route and sorts soonest first', () => {
            const {service, ctrl} = setup();
            service.loadExpiring(GUILD_ID);
            ctrl.expectOne(r => r.url === expiringUrl).flush([
                item({id: 'late', expiresAt: '2026-08-09T00:00:00Z'}),
                item({id: 'soon', expiresAt: '2026-08-04T00:00:00Z'}),
            ]);
            expect(service.expiringFor(GUILD_ID).map(i => i.id)).toEqual(['soon', 'late']);
        });

        it('serves a second open from cache', () => {
            const {service, ctrl} = setup();
            service.loadExpiring(GUILD_ID);
            ctrl.expectOne(r => r.url === expiringUrl).flush([]);
            service.loadExpiring(GUILD_ID);
            ctrl.expectNone(r => r.url === expiringUrl);
        });

        it('refetches once an item event has made it stale', () => {
            const {service, ctrl} = setup();
            service.loadExpiring(GUILD_ID);
            ctrl.expectOne(r => r.url === expiringUrl).flush([]);

            fire('guild.PantryItemUpdated', {guildId: GUILD_ID, channelId: 'chan_other', item: item()});

            service.loadExpiring(GUILD_ID);
            ctrl.expectOne(r => r.url === expiringUrl).flush([]);
        });

        it('drops a deleted item from the cached answer immediately', () => {
            const {service, ctrl} = setup();
            service.loadExpiring(GUILD_ID);
            ctrl.expectOne(r => r.url === expiringUrl).flush([item({expiresAt: '2026-08-04T00:00:00Z'})]);

            fire('guild.PantryItemDeleted', {guildId: GUILD_ID, channelId: CHANNEL, itemId: 'pitm_1'});
            expect(service.expiringFor(GUILD_ID)).toEqual([]);
        });

        it('patches a cached expiring row from an update event, whatever pantry it came from', () => {
            const {service, ctrl} = setup();
            service.loadExpiring(GUILD_ID);
            ctrl.expectOne(r => r.url === expiringUrl).flush([item({expiresAt: '2026-08-04T00:00:00Z'})]);

            fire('guild.PantryItemUpdated', {
                guildId: GUILD_ID,
                channelId: CHANNEL,
                item: item({name: 'Oat milk', expiresAt: '2026-08-04T00:00:00Z'}),
            });
            expect(service.expiringFor(GUILD_ID)[0].name).toBe('Oat milk');
        });
    });
});
