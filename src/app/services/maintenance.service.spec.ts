import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {Subject} from 'rxjs';
import {MaintenanceService} from './maintenance.service';
import {ApiConfigService} from './api-config.service';
import {RealtimeConnectionService} from './realtime-connection.service';
import {
    AssetStatus,
    MaintenanceAsset,
    MaintenanceAttentionEntry,
    MaintenanceRecord,
} from '../dtos/response/maintenance.dto';

const BASE = 'https://api.test.example';
const GUILD = `${BASE}/api/v1/guild`;
const CHANNEL = 'chan_upkeep';
const GUILD_ID = 'gild_1';

const ASSETS_URL = `${GUILD}/channels/${CHANNEL}/maintenance-assets`;
const RECORDS_URL = `${GUILD}/channels/${CHANNEL}/maintenance-records`;
const ATTENTION_URL = `${GUILD}/guilds/${GUILD_ID}/maintenance/attention`;

/** Whatever the module subscribed to on the fake hub, so a test can fire a server event. */
let hubHandlers: Map<string, Subject<any>>;
/** Every registration in order, so the "registered exactly once" rule can be asserted. */
let registrations: string[];

function subjectFor(event: string): Subject<any> {
    let subject = hubHandlers.get(event);
    if (!subject) {
        subject = new Subject<any>();
        hubHandlers.set(event, subject);
    }
    return subject;
}

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
                    on: (event: string, handler: (payload: any) => void) => {
                        registrations.push(event);
                        subjectFor(event).subscribe(handler);
                    },
                    stream: (event: string) => {
                        registrations.push(event);
                        return subjectFor(event).asObservable();
                    },
                    off: () => undefined,
                },
            },
        ],
    });

    return {
        service: TestBed.inject(MaintenanceService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

function asset(overrides: Partial<MaintenanceAsset> = {}): MaintenanceAsset {
    return {
        id: 'masset_1',
        channelId: CHANNEL,
        name: 'Boiler',
        status: AssetStatus.Ok,
        isServiceOverdue: false,
        isWarrantyExpiring: false,
        addedByUserId: 'user_1',
        ...overrides,
    };
}

function record(overrides: Partial<MaintenanceRecord> = {}): MaintenanceRecord {
    return {
        id: 'mrec_1',
        assetId: 'masset_1',
        channelId: CHANNEL,
        title: 'Annual service',
        performedAt: '2026-08-01T10:00:00Z',
        performedByUserId: 'user_1',
        ...overrides,
    };
}

function entry(
    overrides: Partial<MaintenanceAsset> = {},
    reasons: string[] = ['broken'],
): MaintenanceAttentionEntry {
    return {asset: asset(overrides), reasons};
}

/** Opens one channel and answers both halves of the pair `loadFor` fires. */
function load(
    service: MaintenanceService,
    ctrl: HttpTestingController,
    assets: MaintenanceAsset[] = [],
    records: MaintenanceRecord[] = [],
    nextCursor: string | null = null,
) {
    service.loadFor(CHANNEL);
    ctrl.expectOne(ASSETS_URL).flush(assets);
    ctrl.expectOne(r => r.url === RECORDS_URL).flush({items: records, nextCursor});
}

function fire(event: string, payload: unknown) {
    const subject = hubHandlers.get(event);
    if (!subject) throw new Error(`no handler registered for ${event}`);
    subject.next(payload);
}

describe('MaintenanceService', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    describe('realtime registration', () => {
        it('registers the six maintenance events exactly once each', () => {
            setup();
            expect(registrations).toEqual([
                'guild.MaintenanceAssetCreated',
                'guild.MaintenanceAssetUpdated',
                'guild.MaintenanceAssetDeleted',
                'guild.MaintenanceRecordCreated',
                'guild.MaintenanceRecordUpdated',
                'guild.MaintenanceRecordDeleted',
            ]);
        });
    });

    describe('opening a channel', () => {
        it('fetches both halves once per channel however often loadFor is called', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [asset()], [record()]);

            service.loadFor(CHANNEL);
            ctrl.expectNone(ASSETS_URL);
            ctrl.expectNone(r => r.url === RECORDS_URL);

            expect(service.stateFor(CHANNEL).assets.length).toBe(1);
            expect(service.stateFor(CHANNEL).records.length).toBe(1);
            expect(service.stateFor(CHANNEL).loaded).toBe(true);
            expect(service.stateFor(CHANNEL).loading).toBe(false);
        });

        it('asks the log for a full page', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            ctrl.expectOne(ASSETS_URL).flush([]);
            const req = ctrl.expectOne(r => r.url === RECORDS_URL);
            expect(req.request.params.get('limit')).toBe('50');
            req.flush({items: [], nextCursor: null});
        });

        it('reads an unopened channel as empty rather than loaded', () => {
            const {service} = setup();
            expect(service.stateFor('chan_other').assets).toEqual([]);
            expect(service.stateFor('chan_other').records).toEqual([]);
            expect(service.stateFor('chan_other').loaded).toBe(false);
            expect(service.stateFor('chan_other').recordsCursor).toBeNull();
        });

        it('puts what needs a human first, then sorts by name', () => {
            const {service, ctrl} = setup();
            load(
                service,
                ctrl,
                [
                    asset({id: 'a', name: 'Zed', status: AssetStatus.Ok}),
                    asset({id: 'b', name: 'Retired', status: AssetStatus.OutOfService}),
                    asset({id: 'c', name: 'Washer', status: AssetStatus.Broken}),
                    asset({id: 'd', name: 'Alarm', isServiceOverdue: true}),
                ],
                [],
            );
            expect(service.stateFor(CHANNEL).assets.map(a => a.name)).toEqual([
                'Washer',
                'Alarm',
                'Zed',
                'Retired',
            ]);
        });

        it('lists the log newest first', () => {
            const {service, ctrl} = setup();
            load(
                service,
                ctrl,
                [],
                [
                    record({id: 'old', performedAt: '2026-07-01T10:00:00Z'}),
                    record({id: 'new', performedAt: '2026-08-01T10:00:00Z'}),
                ],
            );
            expect(service.stateFor(CHANNEL).records.map(r => r.id)).toEqual(['new', 'old']);
        });

        it('normalizes an unrecognised status to Ok and a numeric one to its name', () => {
            const {service, ctrl} = setup();
            load(
                service,
                ctrl,
                [
                    asset({id: 'a', name: 'Numeric', status: 2 as unknown as AssetStatus}),
                    asset({id: 'b', name: 'Garbage', status: 'Melted' as AssetStatus}),
                ],
                [],
            );
            const byName = new Map(service.stateFor(CHANNEL).assets.map(a => [a.name, a.status]));
            expect(byName.get('Numeric')).toBe(AssetStatus.Broken);
            expect(byName.get('Garbage')).toBe(AssetStatus.Ok);
        });

        it('truncates a fractional cost rather than letting it poison a sum', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [], [record({costMinor: 1250.7})]);
            expect(service.stateFor(CHANNEL).records[0].costMinor).toBe(1250);
        });

        it('keeps the catalogue when only the log fails', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            ctrl.expectOne(ASSETS_URL).flush([asset()]);
            ctrl.expectOne(r => r.url === RECORDS_URL).flush('nope', {
                status: 500,
                statusText: 'Server Error',
            });

            expect(service.stateFor(CHANNEL).assets.length).toBe(1);
            expect(service.stateFor(CHANNEL).records).toEqual([]);
            expect(service.stateFor(CHANNEL).failed).toBe(false);
        });

        it('keeps the log when only the catalogue fails', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            ctrl.expectOne(ASSETS_URL).flush('nope', {status: 500, statusText: 'Server Error'});
            ctrl.expectOne(r => r.url === RECORDS_URL).flush({items: [record()], nextCursor: null});

            expect(service.stateFor(CHANNEL).records.length).toBe(1);
            expect(service.stateFor(CHANNEL).failed).toBe(false);
        });

        it('reports failed only when both halves fail', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            ctrl.expectOne(ASSETS_URL).flush('nope', {status: 500, statusText: 'Server Error'});
            ctrl.expectOne(r => r.url === RECORDS_URL).flush('nope', {
                status: 500,
                statusText: 'Server Error',
            });

            expect(service.stateFor(CHANNEL).failed).toBe(true);
            expect(service.stateFor(CHANNEL).forbidden).toBe(false);
            expect(service.stateFor(CHANNEL).loading).toBe(false);
        });

        // A 403 is the house having no Maintenance module, which the view renders as nothing at
        // all. It must never be reported as a failure the user could retry.
        it('reports a 403 as forbidden and not as failed', () => {
            const {service, ctrl} = setup();
            service.loadFor(CHANNEL);
            ctrl.expectOne(ASSETS_URL).flush('nope', {status: 403, statusText: 'Forbidden'});
            ctrl.expectOne(r => r.url === RECORDS_URL).flush('nope', {
                status: 403,
                statusText: 'Forbidden',
            });

            expect(service.stateFor(CHANNEL).forbidden).toBe(true);
            expect(service.stateFor(CHANNEL).failed).toBe(false);
        });

        it('finds an asset by id inside the channel that holds it', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [asset({id: 'masset_9', name: 'Mower'})], []);
            expect(service.assetById(CHANNEL, 'masset_9')?.name).toBe('Mower');
            expect(service.assetById(CHANNEL, 'nope')).toBeNull();
        });
    });

    describe('paging the log', () => {
        it('appends the next page and carries the cursor forward', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [], [record({id: 'r1', performedAt: '2026-08-01T10:00:00Z'})], 'cur1');
            expect(service.stateFor(CHANNEL).recordsCursor).toBe('cur1');

            service.loadMoreRecords(CHANNEL);
            const req = ctrl.expectOne(r => r.url === RECORDS_URL);
            expect(req.request.params.get('cursor')).toBe('cur1');
            req.flush({
                items: [record({id: 'r2', performedAt: '2026-07-01T10:00:00Z'})],
                nextCursor: 'cur2',
            });

            expect(service.stateFor(CHANNEL).records.map(r => r.id)).toEqual(['r1', 'r2']);
            expect(service.stateFor(CHANNEL).recordsCursor).toBe('cur2');
            expect(service.stateFor(CHANNEL).loadingMore).toBe(false);
        });

        it('does nothing when there is no next page', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [], [record()], null);
            service.loadMoreRecords(CHANNEL);
            ctrl.expectNone(r => r.url === RECORDS_URL);
        });

        it('drops rows the page repeats rather than duplicating them', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [], [record({id: 'r1'})], 'cur1');

            service.loadMoreRecords(CHANNEL);
            ctrl.expectOne(r => r.url === RECORDS_URL).flush({
                items: [record({id: 'r1'}), record({id: 'r2', performedAt: '2026-07-01T10:00:00Z'})],
                nextCursor: null,
            });

            expect(service.stateFor(CHANNEL).records.map(r => r.id)).toEqual(['r1', 'r2']);
            expect(service.stateFor(CHANNEL).recordsCursor).toBeNull();
        });

        it('clears loadingMore when the page fails', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [], [record()], 'cur1');
            service.loadMoreRecords(CHANNEL);
            ctrl.expectOne(r => r.url === RECORDS_URL).flush('nope', {
                status: 500,
                statusText: 'Server Error',
            });
            expect(service.stateFor(CHANNEL).loadingMore).toBe(false);
        });
    });

    describe('the guild-wide attention board', () => {
        it('asks the guild route and sorts the most urgent reason first', () => {
            const {service, ctrl} = setup();
            service.loadAttention(GUILD_ID);
            ctrl.expectOne(ATTENTION_URL).flush([
                entry({id: 'a', name: 'Alarm'}, ['warranty_expiring']),
                entry({id: 'b', name: 'Washer'}, ['broken']),
                entry({id: 'c', name: 'Mower'}, ['service_overdue']),
            ]);

            expect(service.attentionFor(GUILD_ID).entries.map(e => e.asset.name)).toEqual([
                'Washer',
                'Mower',
                'Alarm',
            ]);
            expect(service.attentionFor(GUILD_ID).loaded).toBe(true);
        });

        it('serves a second open from cache', () => {
            const {service, ctrl} = setup();
            service.loadAttention(GUILD_ID);
            ctrl.expectOne(ATTENTION_URL).flush([]);
            service.loadAttention(GUILD_ID);
            ctrl.expectNone(ATTENTION_URL);
        });

        it('refetches when force is set', () => {
            const {service, ctrl} = setup();
            service.loadAttention(GUILD_ID);
            ctrl.expectOne(ATTENTION_URL).flush([]);
            service.loadAttention(GUILD_ID, true);
            ctrl.expectOne(ATTENTION_URL).flush([]);
        });

        it('refetches once an asset event has made it stale', () => {
            const {service, ctrl} = setup();
            service.loadAttention(GUILD_ID);
            ctrl.expectOne(ATTENTION_URL).flush([]);

            fire('guild.MaintenanceAssetUpdated', {
                guildId: GUILD_ID,
                channelId: 'chan_other',
                asset: asset(),
            });

            service.loadAttention(GUILD_ID);
            ctrl.expectOne(ATTENTION_URL).flush([]);
        });

        it('refetches after a write marked it stale', () => {
            const {service, ctrl} = setup();
            service.loadAttention(GUILD_ID);
            ctrl.expectOne(ATTENTION_URL).flush([]);

            service.setStatus(GUILD_ID, CHANNEL, 'masset_1', AssetStatus.Broken).subscribe();
            ctrl.expectOne(`${GUILD}/maintenance-assets/masset_1/status`).flush(
                asset({status: AssetStatus.Broken}),
            );

            service.loadAttention(GUILD_ID);
            ctrl.expectOne(ATTENTION_URL).flush([]);
        });

        it('reports a 403 as forbidden and stays unloaded', () => {
            const {service, ctrl} = setup();
            service.loadAttention(GUILD_ID);
            ctrl.expectOne(ATTENTION_URL).flush('nope', {status: 403, statusText: 'Forbidden'});

            expect(service.attentionFor(GUILD_ID).forbidden).toBe(true);
            expect(service.attentionFor(GUILD_ID).loaded).toBe(false);
            expect(service.attentionFor(GUILD_ID).loading).toBe(false);
        });

        it('leaves forbidden alone on an ordinary failure', () => {
            const {service, ctrl} = setup();
            service.loadAttention(GUILD_ID);
            ctrl.expectOne(ATTENTION_URL).flush('nope', {status: 500, statusText: 'Server Error'});

            expect(service.attentionFor(GUILD_ID).forbidden).toBe(false);
            expect(service.attentionFor(GUILD_ID).loaded).toBe(false);
        });

        it('reads a guild nobody has opened as empty', () => {
            const {service} = setup();
            expect(service.attentionFor('gild_other').entries).toEqual([]);
            expect(service.attentionFor('gild_other').loaded).toBe(false);
        });

        // The board carries its own copy of the asset, and a status change is what whoever is
        // looking at it is waiting to see.
        it('keeps its copy of an asset current when a status event arrives', () => {
            const {service, ctrl} = setup();
            service.loadAttention(GUILD_ID);
            ctrl.expectOne(ATTENTION_URL).flush([entry({name: 'Washer'}, ['broken'])]);

            fire('guild.MaintenanceAssetUpdated', {
                guildId: GUILD_ID,
                channelId: CHANNEL,
                asset: asset({name: 'Washer', status: AssetStatus.Ok}),
            });

            expect(service.attentionFor(GUILD_ID).entries[0].asset.status).toBe(AssetStatus.Ok);
        });

        it('never adds a row the server did not put on the board', () => {
            const {service, ctrl} = setup();
            service.loadAttention(GUILD_ID);
            ctrl.expectOne(ATTENTION_URL).flush([]);

            fire('guild.MaintenanceAssetUpdated', {
                guildId: GUILD_ID,
                channelId: CHANNEL,
                asset: asset({status: AssetStatus.Broken}),
            });

            expect(service.attentionFor(GUILD_ID).entries).toEqual([]);
        });

        it('drops a deleted asset off the board immediately', () => {
            const {service, ctrl} = setup();
            service.loadAttention(GUILD_ID);
            ctrl.expectOne(ATTENTION_URL).flush([entry()]);

            fire('guild.MaintenanceAssetDeleted', {
                guildId: GUILD_ID,
                channelId: CHANNEL,
                assetId: 'masset_1',
            });

            expect(service.attentionFor(GUILD_ID).entries).toEqual([]);
        });
    });

    describe('realtime events', () => {
        it('adds a created asset to an open channel', () => {
            const {service, ctrl} = setup();
            load(service, ctrl);
            fire('guild.MaintenanceAssetCreated', {
                guildId: GUILD_ID,
                channelId: CHANNEL,
                asset: asset({id: 'new'}),
            });
            expect(service.stateFor(CHANNEL).assets.map(a => a.id)).toEqual(['new']);
        });

        it('ignores an asset event for a channel nobody has opened', () => {
            const {service} = setup();
            fire('guild.MaintenanceAssetCreated', {
                guildId: GUILD_ID,
                channelId: 'chan_other',
                asset: asset(),
            });
            expect(service.stateFor('chan_other').assets).toEqual([]);
            expect(service.stateFor('chan_other').loaded).toBe(false);
        });

        it('treats a re-delivered create as an upsert rather than a duplicate row', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [asset()]);
            fire('guild.MaintenanceAssetCreated', {
                guildId: GUILD_ID,
                channelId: CHANNEL,
                asset: asset({name: 'Renamed'}),
            });
            expect(service.stateFor(CHANNEL).assets.length).toBe(1);
            expect(service.stateFor(CHANNEL).assets[0].name).toBe('Renamed');
        });

        it('removes a deleted asset from the channel', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [asset()]);
            fire('guild.MaintenanceAssetDeleted', {
                guildId: GUILD_ID,
                channelId: CHANNEL,
                assetId: 'masset_1',
            });
            expect(service.stateFor(CHANNEL).assets).toEqual([]);
        });

        // What was done to a machine outlives the catalogue row it was done to.
        it('keeps the log when the asset it points at is deleted', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [asset()], [record()]);
            fire('guild.MaintenanceAssetDeleted', {
                guildId: GUILD_ID,
                channelId: CHANNEL,
                assetId: 'masset_1',
            });
            expect(service.stateFor(CHANNEL).records.map(r => r.id)).toEqual(['mrec_1']);
        });

        it('adds a created record to an open channel', () => {
            const {service, ctrl} = setup();
            load(service, ctrl);
            fire('guild.MaintenanceRecordCreated', {
                guildId: GUILD_ID,
                channelId: CHANNEL,
                record: record({id: 'new'}),
            });
            expect(service.stateFor(CHANNEL).records.map(r => r.id)).toEqual(['new']);
        });

        it('ignores a record event for a channel nobody has opened', () => {
            const {service} = setup();
            fire('guild.MaintenanceRecordCreated', {
                guildId: GUILD_ID,
                channelId: 'chan_other',
                record: record(),
            });
            expect(service.stateFor('chan_other').records).toEqual([]);
        });

        it('applies an updated record in place', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [], [record()]);
            fire('guild.MaintenanceRecordUpdated', {
                guildId: GUILD_ID,
                channelId: CHANNEL,
                record: record({title: 'Callout'}),
            });
            expect(service.stateFor(CHANNEL).records.length).toBe(1);
            expect(service.stateFor(CHANNEL).records[0].title).toBe('Callout');
        });

        it('removes a deleted record', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [], [record()]);
            fire('guild.MaintenanceRecordDeleted', {
                guildId: GUILD_ID,
                channelId: CHANNEL,
                recordId: 'mrec_1',
            });
            expect(service.stateFor(CHANNEL).records).toEqual([]);
        });
    });

    describe('writes', () => {
        it('applies a created asset without waiting for the realtime event', () => {
            const {service, ctrl} = setup();
            load(service, ctrl);

            service.addAsset(GUILD_ID, CHANNEL, {name: 'Mower'}).subscribe();
            ctrl.expectOne(ASSETS_URL).flush(asset({id: 'masset_2', name: 'Mower'}));

            expect(service.stateFor(CHANNEL).assets.map(a => a.id)).toEqual(['masset_2']);
        });

        it('is idempotent when the echo event arrives after the write', () => {
            const {service, ctrl} = setup();
            load(service, ctrl);

            service.addAsset(GUILD_ID, CHANNEL, {name: 'Mower'}).subscribe();
            const created = asset({id: 'masset_2', name: 'Mower'});
            ctrl.expectOne(ASSETS_URL).flush(created);
            fire('guild.MaintenanceAssetCreated', {
                guildId: GUILD_ID,
                channelId: CHANNEL,
                asset: created,
            });

            expect(service.stateFor(CHANNEL).assets.length).toBe(1);
        });

        it('applies an edited asset', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [asset()]);

            service.editAsset(GUILD_ID, CHANNEL, 'masset_1', {name: 'Boiler II'}).subscribe();
            ctrl.expectOne(`${GUILD}/maintenance-assets/masset_1`).flush(asset({name: 'Boiler II'}));

            expect(service.stateFor(CHANNEL).assets[0].name).toBe('Boiler II');
        });

        it('drops the row on a successful delete', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [asset()]);

            service.removeAsset(GUILD_ID, CHANNEL, 'masset_1').subscribe();
            ctrl.expectOne(`${GUILD}/maintenance-assets/masset_1`).flush(null);

            expect(service.stateFor(CHANNEL).assets).toEqual([]);
        });

        it('sends a status with no note as a bare status', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [asset()]);

            service.setStatus(GUILD_ID, CHANNEL, 'masset_1', AssetStatus.Broken).subscribe();
            const req = ctrl.expectOne(`${GUILD}/maintenance-assets/masset_1/status`);
            expect(req.request.body).toEqual({status: AssetStatus.Broken});
            req.flush(asset({status: AssetStatus.Broken}));

            expect(service.stateFor(CHANNEL).assets[0].status).toBe(AssetStatus.Broken);
        });

        it('sends the note when one was given', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [asset()]);

            service.setStatus(GUILD_ID, CHANNEL, 'masset_1', AssetStatus.Broken, 'drum seized').subscribe();
            const req = ctrl.expectOne(`${GUILD}/maintenance-assets/masset_1/status`);
            expect(req.request.body).toEqual({status: AssetStatus.Broken, note: 'drum seized'});
            req.flush(asset({status: AssetStatus.Broken, statusNote: 'drum seized'}));

            expect(service.stateFor(CHANNEL).assets[0].statusNote).toBe('drum seized');
        });

        // A service moves the schedule and writes a log line, and it does not clear a Broken
        // status. Both halves of the answer have to land.
        it('applies both halves of a recorded service', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [asset({status: AssetStatus.Broken})], []);

            service.recordService(GUILD_ID, CHANNEL, 'masset_1').subscribe();
            ctrl.expectOne(`${GUILD}/maintenance-assets/masset_1/serviced`).flush({
                asset: asset({status: AssetStatus.Broken, lastServicedAt: '2026-08-20T10:00:00Z'}),
                record: record({id: 'mrec_9'}),
            });

            expect(service.stateFor(CHANNEL).assets[0].lastServicedAt).toBe('2026-08-20T10:00:00Z');
            expect(service.stateFor(CHANNEL).assets[0].status).toBe(AssetStatus.Broken);
            expect(service.stateFor(CHANNEL).records.map(r => r.id)).toEqual(['mrec_9']);
        });

        it('applies a created record', () => {
            const {service, ctrl} = setup();
            load(service, ctrl);

            service.addRecord(CHANNEL, {title: 'Callout'}).subscribe();
            ctrl.expectOne(RECORDS_URL).flush(record({id: 'mrec_2', title: 'Callout'}));

            expect(service.stateFor(CHANNEL).records.map(r => r.id)).toEqual(['mrec_2']);
        });

        it('applies an edited record', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [], [record()]);

            service.editRecord(CHANNEL, 'mrec_1', {title: 'Callout'}).subscribe();
            ctrl.expectOne(`${GUILD}/maintenance-records/mrec_1`).flush(record({title: 'Callout'}));

            expect(service.stateFor(CHANNEL).records[0].title).toBe('Callout');
        });

        it('drops the log line on a successful delete', () => {
            const {service, ctrl} = setup();
            load(service, ctrl, [], [record()]);

            service.removeRecord(CHANNEL, 'mrec_1').subscribe();
            ctrl.expectOne(`${GUILD}/maintenance-records/mrec_1`).flush(null);

            expect(service.stateFor(CHANNEL).records).toEqual([]);
        });
    });
});
