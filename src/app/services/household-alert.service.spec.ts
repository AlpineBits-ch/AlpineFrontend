import {TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';
import {HouseholdAlertService} from './household-alert.service';
import {NotificationService} from './notification.service';
import {RealtimeConnectionService} from './realtime-connection.service';
import {HouseholdAlert} from '../dtos/response/household-alert.dto';

/** Handlers registered on the fake hub, so a test can fire a server event by name. */
const hubHandlers = new Map<string, ((payload: never) => void)[]>();

function fire(event: string, payload: unknown): void {
    for (const handler of hubHandlers.get(event) ?? []) (handler as (p: unknown) => void)(payload);
}

/** Every OS notification the service raised, newest last. */
const notifications: { title: string; message: string; extra?: Record<string, string> }[] = [];

function alert(overrides: Partial<HouseholdAlert> = {}): HouseholdAlert {
    return {
        guildId: 'gild_1',
        channelId: 'chan_chores',
        kind: 'chore.due',
        targetId: 'occr_1',
        title: 'Your turn',
        body: 'Take the bins out',
        data: {choreId: 'chor_1', dueAt: '2026-08-06T18:00:00.000Z'},
        ...overrides,
    };
}

function setup() {
    hubHandlers.clear();
    notifications.length = 0;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            {
                provide: RealtimeConnectionService,
                useValue: {
                    on: (event: string, handler: (payload: never) => void) => {
                        const existing = hubHandlers.get(event) ?? [];
                        hubHandlers.set(event, [...existing, handler]);
                    },
                },
            },
            {
                provide: NotificationService,
                useValue: {
                    createNotification: (params: {
                        title: string;
                        message: string;
                        extra?: Record<string, string>;
                    }) => {
                        notifications.push(params);
                        return Promise.resolve();
                    },
                },
            },
        ],
    });
    return TestBed.inject(HouseholdAlertService);
}

describe('HouseholdAlertService', () => {
    it('registers the one alert event exactly once', () => {
        setup();
        // One event for every kind, deliberately: a per-kind subscription would silently stop
        // delivering the moment the server added a kind this build has never heard of.
        expect(hubHandlers.get('guild.HouseholdAlert')?.length).toBe(1);
    });

    it('renders the server-written title and body as given', () => {
        setup();
        fire('guild.HouseholdAlert', alert());

        expect(notifications.length).toBe(1);
        expect(notifications[0].title).toBe('Your turn');
        expect(notifications[0].message).toBe('Take the bins out');
    });

    it('carries the household push keys, so a click has what a deep-link needs', () => {
        setup();
        fire('guild.HouseholdAlert', alert());

        expect(notifications[0].extra).toEqual({
            type: 'household',
            kind: 'chore.due',
            targetId: 'occr_1',
            guildId: 'gild_1',
            channelId: 'chan_chores',
        });
    });

    it('notifies about a kind it has never heard of', () => {
        setup();
        // The whole point of one envelope: copy is server-side, so a kind added after this build
        // still says something true and still deep-links.
        fire('guild.HouseholdAlert', alert({kind: 'laundry.finished', targetId: 'wash_1'}));

        expect(notifications.length).toBe(1);
        expect(notifications[0].extra?.['kind']).toBe('laundry.finished');
    });

    it('buzzes once per kind and target, so a reconnect redelivery is silent', () => {
        setup();
        fire('guild.HouseholdAlert', alert());
        fire('guild.HouseholdAlert', alert());

        expect(notifications.length).toBe(1);
    });

    it('still notifies for a different kind about the same target', () => {
        setup();
        // A pantry channel is the target of every one of its expiry sweeps, and an occurrence can
        // be named by more than one kind - keying the dedupe on the id alone would silence those.
        fire('guild.HouseholdAlert', alert({kind: 'pantry.expiring', targetId: 'chan_pantry'}));
        fire('guild.HouseholdAlert', alert({kind: 'pantry.restock', targetId: 'chan_pantry'}));

        expect(notifications.length).toBe(2);
    });

    it('drops a payload with nothing to say or point at rather than notifying about nothing', () => {
        setup();
        fire('guild.HouseholdAlert', alert({title: ''}));
        fire('guild.HouseholdAlert', alert({targetId: ''}));
        fire('guild.HouseholdAlert', undefined);

        expect(notifications.length).toBe(0);
    });

    it('publishes each alert for surfaces that reconcile rather than notify', () => {
        const service = setup();
        const seen: HouseholdAlert[] = [];
        service.alerts$.subscribe(a => seen.push(a));

        fire('guild.HouseholdAlert', alert());
        fire('guild.HouseholdAlert', alert());

        // Deduped on the way out too: a glance surface refetching per redelivery would spend a
        // request per reconnect for a change it already has.
        expect(seen.length).toBe(1);
        expect(seen[0].guildId).toBe('gild_1');
    });
});
