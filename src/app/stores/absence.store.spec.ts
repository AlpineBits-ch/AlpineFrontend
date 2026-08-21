import {Signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {HttpErrorResponse} from '@angular/common/http';
import {Observable, of, Subject} from 'rxjs';
import {AbsenceGuildState, AbsenceStore} from './absence.store';
import {Absence, AbsenceSaved} from '../dtos/response/absence.dto';
import {CreateAbsenceDto, UpdateAbsenceDto} from '../dtos/request/absence.dto';
import {AbsenceApiService} from '../services/absence-api.service';
import {ChoreService} from '../services/chore.service';
import {RealtimeConnectionService} from '../services/realtime-connection.service';
import {FakeRealtimeConnection} from '../testing/fake-realtime-connection';

const HOUR = 3_600_000;

function absence(id: string, overrides: Partial<Absence> = {}): Absence {
    return {
        id,
        guildId: 'g1',
        userId: 'u1',
        startAt: new Date(Date.now() - HOUR).toISOString(),
        endAt: new Date(Date.now() + HOUR).toISOString(),
        note: null,
        createdByUserId: 'u1',
        createdAt: '2026-08-01T00:00:00Z',
        ...overrides,
    };
}

function saved(row: Absence, choresReassigned = 0): AbsenceSaved {
    return {absence: row, choresReassigned};
}

interface StateReader {
    stateFor(guildId: string): Signal<AbsenceGuildState>;
}

function idsIn(store: StateReader, guildId: string): string[] {
    return store
        .stateFor(guildId)()
        .absences.map(a => a.id);
}

/** Subject-backed list so response timing is controlled and requests can be counted. */
class FakeAbsenceApi {
    listPending: Subject<Absence[]>[] = [];
    createResult: AbsenceSaved = saved(absence('created'));
    updateResult: AbsenceSaved = saved(absence('updated'));

    list(_guildId: string, _from?: string | null, _to?: string | null): Observable<Absence[]> {
        const subject = new Subject<Absence[]>();
        this.listPending.push(subject);
        return subject.asObservable();
    }

    create(_guildId: string, _body: CreateAbsenceDto): Observable<AbsenceSaved> {
        return of(this.createResult);
    }

    update(_absenceId: string, _body: UpdateAbsenceDto): Observable<AbsenceSaved> {
        return of(this.updateResult);
    }

    delete(_absenceId: string): Observable<void> {
        return of(undefined);
    }

    settle(rows: Absence[], index = 0): void {
        this.listPending[index].next(rows);
        this.listPending[index].complete();
    }

    fail(status: number, index = 0): void {
        this.listPending[index].error(new HttpErrorResponse({status}));
    }
}

class FakeChoreService {
    invalidations = 0;

    invalidateAll(): void {
        this.invalidations++;
    }
}

function setup() {
    const api = new FakeAbsenceApi();
    const chores = new FakeChoreService();
    const ws = new FakeRealtimeConnection();
    TestBed.configureTestingModule({
        providers: [
            {provide: AbsenceApiService, useValue: api},
            {provide: ChoreService, useValue: chores},
            {provide: RealtimeConnectionService, useValue: ws},
        ],
    });
    return {api, chores, ws, store: TestBed.inject(AbsenceStore)};
}

describe('AbsenceStore', () => {
    it('loads a guild and reads it back soonest start first', () => {
        const {api, store} = setup();

        store.loadFor('g1');
        api.settle([
            absence('later', {startAt: '2026-09-01T00:00:00Z'}),
            absence('earlier', {startAt: '2026-08-01T00:00:00Z'}),
        ]);

        expect(idsIn(store, 'g1')).toEqual(['earlier', 'later']);
        expect(store.stateFor('g1')().loaded).toBe(true);
    });

    it('fetches once per guild for the session', () => {
        const {api, store} = setup();

        store.loadFor('g1');
        api.settle([absence('a1')]);
        store.loadFor('g1');
        store.loadFor('g1');

        expect(api.listPending.length).toBe(1);
    });

    it('refresh refetches a guild already loaded', () => {
        const {api, store} = setup();

        store.loadFor('g1');
        api.settle([absence('a1')]);
        store.refresh('g1');

        expect(api.listPending.length).toBe(2);
    });

    it('reads a guild nobody has opened as the same frozen empty state', () => {
        const {store} = setup();

        const first = store.stateFor('unopened')();
        expect(first.absences).toEqual([]);
        expect(first.loaded).toBe(false);
        expect(store.stateFor('unopened')()).toBe(first);
    });

    it('separates a 403 from a network failure', () => {
        const {api, store} = setup();

        store.loadFor('g1');
        api.fail(403);

        expect(store.stateFor('g1')().forbidden).toBe(true);
        expect(store.stateFor('g1')().failed).toBe(false);

        store.refresh('g1');
        api.fail(500, 1);

        expect(store.stateFor('g1')().forbidden).toBe(false);
        expect(store.stateFor('g1')().failed).toBe(true);
    });

    it('applies a realtime save into a guild it holds', () => {
        const {api, store, ws} = setup();

        store.loadFor('g1');
        api.settle([absence('a1')]);
        ws.emit('guild.AbsenceCreated', {guildId: 'g1', absence: absence('a2'), choresReassigned: 0});

        expect(idsIn(store, 'g1')).toEqual(['a1', 'a2']);
    });

    it('drops a realtime save for a guild it holds nothing for', () => {
        const {store, ws} = setup();

        ws.emit('guild.AbsenceCreated', {guildId: 'g9', absence: absence('a1'), choresReassigned: 0});

        expect(store.stateFor('g9')().absences).toEqual([]);
    });

    it('invalidates the rota only when the save moved chores', () => {
        const {api, chores, store, ws} = setup();

        store.loadFor('g1');
        api.settle([]);
        ws.emit('guild.AbsenceUpdated', {guildId: 'g1', absence: absence('a1'), choresReassigned: 0});
        expect(chores.invalidations).toBe(0);

        ws.emit('guild.AbsenceUpdated', {guildId: 'g1', absence: absence('a1'), choresReassigned: 3});
        expect(chores.invalidations).toBe(1);
    });

    it('removes a row on a realtime delete', () => {
        const {api, store, ws} = setup();

        store.loadFor('g1');
        api.settle([absence('a1'), absence('a2')]);
        ws.emit('guild.AbsenceDeleted', {guildId: 'g1', absenceId: 'a1', userId: 'u1'});

        expect(idsIn(store, 'g1')).toEqual(['a2']);
    });

    it('keeps a guild written into but never fetched open to realtime', () => {
        const {store, ws} = setup();

        store.create('g9', {startAt: 'x', endAt: 'y'}).subscribe();
        store.remove('g9', 'created').subscribe();
        ws.emit('guild.AbsenceCreated', {guildId: 'g9', absence: absence('a1'), choresReassigned: 0});

        expect(idsIn(store, 'g9')).toEqual(['a1']);
    });

    it('applies the create echo into a guild never loaded', () => {
        const {chores, store} = setup();
        store.create('g1', {startAt: 'x', endAt: 'y'}).subscribe();

        expect(idsIn(store, 'g1')).toEqual(['created']);
        expect(chores.invalidations).toBe(0);
    });

    it('surfaces choresReassigned from a write by invalidating the rota', () => {
        const {api, chores, store} = setup();
        api.updateResult = saved(absence('a1'), 2);

        store.loadFor('g1');
        api.settle([absence('a1')]);
        store.update('g1', 'a1', {startAt: 'x', endAt: 'y'}).subscribe();

        expect(chores.invalidations).toBe(1);
    });

    it('drops a row once the delete comes back', () => {
        const {api, store} = setup();

        store.loadFor('g1');
        api.settle([absence('a1'), absence('a2')]);
        store.remove('g1', 'a2').subscribe();

        expect(idsIn(store, 'g1')).toEqual(['a1']);
    });

    it('liveIn answers with the absences covering now, forUser with one member', () => {
        const {api, store} = setup();
        const now = Date.now();

        store.loadFor('g1');
        api.settle([
            absence('current', {userId: 'u1'}),
            absence('upcoming', {
                userId: 'u2',
                startAt: new Date(now + HOUR).toISOString(),
                endAt: new Date(now + 2 * HOUR).toISOString(),
            }),
        ]);

        expect(store.liveIn('g1', now).map(a => a.id)).toEqual(['current']);
        expect(store.forUser('g1', 'u2').map(a => a.id)).toEqual(['upcoming']);
    });
});
