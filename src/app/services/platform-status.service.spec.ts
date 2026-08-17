import {TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection, signal} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {Observable, of, Subject, throwError} from 'rxjs';
import {PlatformStatusService, UNVERIFIED_REFERENCE} from './platform-status.service';
import {StatusApiService} from './status-api.service';
import {ConnectionState, RealtimeConnectionService} from './realtime-connection.service';
import {IncidentDto, StatusSummaryDto} from '../dtos/response/status.dto';
import {installMemoryStorage} from '../testing/memory-storage';

const INCIDENT: IncidentDto = {
    reference: 'VNT-4KQ7M2XB',
    kind: 'incident',
    title: 'Elevated error rates affecting Sign-in and accounts',
    impact: 'minor',
    status: 'investigating',
    components: ['accounts'],
    startedAt: '2026-08-05T11:58:00Z',
    resolvedAt: null,
    template: 'elevated_errors',
    url: 'https://status.venta.gg/incident?ref=VNT-4KQ7M2XB',
    updates: [
        {
            status: 'investigating',
            body: 'Some people may not be able to sign in or create an account. We are investigating.',
            template: 'elevated_errors',
            postedAt: '2026-08-05T11:58:00Z',
        },
    ],
};

function summary(overrides: Partial<StatusSummaryDto> = {}): StatusSummaryDto {
    return {
        indicator: 'degraded',
        updatedAt: '2026-08-05T12:04:20Z',
        banner: {
            title: INCIDENT.title,
            body: INCIDENT.updates![0].body,
            severity: 'warning',
            incidentReference: INCIDENT.reference,
            url: INCIDENT.url,
            template: 'elevated_errors',
            componentKey: 'accounts',
        },
        components: [
            {
                key: 'accounts',
                name: 'Sign-in and accounts',
                description: 'Signing in, registration, sessions',
                status: 'degraded_performance',
                statusSince: '2026-08-05T11:58:00Z',
                uptime90d: 0.9987,
            },
        ],
        incidents: [INCIDENT],
        maintenance: [],
        recent: [],
        ...overrides,
    };
}

const OPERATIONAL: StatusSummaryDto = {
    indicator: 'operational',
    updatedAt: '2026-08-05T13:00:00Z',
    banner: null,
    components: [],
    incidents: [],
    maintenance: [],
    recent: [],
};

class FakeApi {
    responses: Observable<StatusSummaryDto>[] = [];
    calls = 0;

    summary(): Observable<StatusSummaryDto> {
        this.calls++;
        return this.responses.shift() ?? of(OPERATIONAL);
    }
}

function setup(responses: Observable<StatusSummaryDto>[] = []): {
    service: PlatformStatusService;
    api: FakeApi;
} {
    const api = new FakeApi();
    api.responses = responses;

    TestBed.configureTestingModule({
        providers: [
            provideZonelessChangeDetection(),
            {provide: StatusApiService, useValue: api},
            {provide: RealtimeConnectionService, useValue: new FakeRealtime()},
        ],
    });

    return {service: TestBed.inject(PlatformStatusService), api};
}

/** Enough of the hub to register handlers against and fire them by name. */
class FakeRealtime {
    readonly connectionState = signal(ConnectionState.Disconnected);
    private handlers = new Map<string, (...args: any[]) => void>();

    on(event: string, handler: (...args: any[]) => void): void {
        this.handlers.set(event, handler);
    }

    fire(event: string, payload: unknown): void {
        this.handlers.get(event)?.(payload);
    }
}

function httpError(status: number): Observable<never> {
    return throwError(() => new HttpErrorResponse({status, statusText: 'nope'}));
}

describe('PlatformStatusService', () => {
    let restoreStorage: () => void;

    beforeEach(() => {
        // Dismissal is persisted, and the stub `localStorage` the test environment ships has no
        // `clear`/`removeItem` - the service's try/catch would swallow that into "never dismissed".
        restoreStorage = installMemoryStorage();
        TestBed.resetTestingModule();
    });

    afterEach(() => restoreStorage());

    it('renders nothing while the platform is operational', () => {
        const {service} = setup([of(OPERATIONAL)]);
        service.probe();

        expect(service.bar()).toBeNull();
        expect(service.banner()).toBeNull();
    });

    it('surfaces the incident bar carrying the server copy untouched', () => {
        const {service} = setup([of(summary())]);
        service.probe();

        expect(service.bar()).toBe('incident');
        expect(service.banner()!.title).toBe(INCIDENT.title);
        expect(service.banner()!.body).toBe(INCIDENT.updates![0].body);
    });

    it('shows a bar for an indicator value it has never heard of rather than ignoring it', () => {
        const {service} = setup([of(summary({indicator: 'brand_new_state'}))]);
        service.probe();

        expect(service.bar()).toBe('incident');
    });

    it('stays silent after a single failed status call', () => {
        const {service} = setup([httpError(503)]);
        service.probe();

        expect(service.bar()).toBeNull();
    });

    it('admits it could not check after two consecutive failures', () => {
        const {service} = setup([httpError(503), httpError(0)]);
        service.probe();
        service.probe();

        expect(service.unverified()).toBe(true);
        expect(service.bar()).toBe('unverified');
    });

    it('counts a 404 like any other failure - an undeployed status API is unverifiable too', () => {
        const {service} = setup([httpError(404), httpError(404)]);
        service.probe();
        service.probe();

        expect(service.unverified()).toBe(true);
        expect(service.bar()).toBe('unverified');
    });

    it('confirms the first failure quickly instead of waiting a whole poll cycle', () => {
        vi.useFakeTimers();
        try {
            const {service, api} = setup([httpError(503), httpError(503)]);
            service.probe();

            expect(api.calls).toBe(1);
            expect(service.bar()).toBeNull();

            vi.advanceTimersByTime(5_000);

            expect(api.calls).toBe(2);
            expect(service.bar()).toBe('unverified');
        } finally {
            vi.useRealTimers();
        }
    });

    it('drops the unverified bar as soon as a call succeeds again', () => {
        const {service} = setup([httpError(503), httpError(503), of(OPERATIONAL)]);
        service.probe();
        service.probe();
        service.probe();

        expect(service.bar()).toBeNull();
    });

    it('keeps a dismissed incident hidden', () => {
        const {service} = setup([of(summary()), of(summary())]);
        service.probe();
        service.dismiss();

        expect(service.bar()).toBeNull();

        service.probe();
        expect(service.bar()).toBeNull();
    });

    it('re-shows a dismissed incident once a newer update is posted', () => {
        const updated = summary({
            incidents: [
                {
                    ...INCIDENT,
                    updates: [
                        {
                            status: 'identified',
                            body: 'We have identified the cause.',
                            template: null,
                            postedAt: '2026-08-05T12:30:00Z',
                        },
                        ...INCIDENT.updates!,
                    ],
                },
            ],
        });

        const {service} = setup([of(summary()), of(updated)]);
        service.probe();
        service.dismiss();
        expect(service.bar()).toBeNull();

        service.probe();
        expect(service.bar()).toBe('incident');
    });

    it('forgets the dismissal once the incident leaves the response', () => {
        const {service} = setup([of(summary()), of(OPERATIONAL), of(summary())]);
        service.probe();
        service.dismiss();

        service.probe(); // incident gone - dismissal is dropped
        service.probe(); // it comes back, and so does the bar
        expect(service.bar()).toBe('incident');
    });

    it('remembers a dismissed unverified bar separately from any incident', () => {
        const {service} = setup([httpError(503), httpError(503)]);
        service.probe();
        service.probe();
        expect(service.bar()).toBe('unverified');

        service.dismiss();
        expect(service.bar()).toBeNull();
        expect(localStorage.getItem('alpine.status.dismissed')).toContain(UNVERIFIED_REFERENCE);
    });

    it('lets a real incident outrank "we could not check"', () => {
        const {service} = setup([of(summary()), httpError(503), httpError(503)]);
        service.probe();
        service.probe();
        service.probe();

        expect(service.unverified()).toBe(true);
        expect(service.bar()).toBe('incident');
    });

    it('does not fire a second call while one is already in flight', () => {
        const pending = new Subject<StatusSummaryDto>();
        const {service, api} = setup([pending.asObservable()]);

        service.probe();
        service.probe();
        service.probe();

        expect(api.calls).toBe(1);
    });

    it('answers component questions by key and stays quiet about keys it does not know', () => {
        const {service} = setup([of(summary())]);
        service.probe();

        expect(service.isComponentDegraded('accounts')).toBe(true);
        expect(service.isComponentDegraded('voice')).toBe(false);
        expect(service.componentStatus('voice')).toBeNull();
    });
});
