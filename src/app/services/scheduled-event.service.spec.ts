import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';

import {ScheduledEventService} from './scheduled-event.service';
import {ApiConfigService} from './api-config.service';

describe('ScheduledEventService', () => {
    let service: ScheduledEventService;
    let http: HttpTestingController;
    const base = 'https://api.test.example/api/v1/guild';

    beforeEach(() => {
        TestBed.configureTestingModule({
            providers: [
                provideHttpClient(),
                provideHttpClientTesting(),
                {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
            ],
        });
        service = TestBed.inject(ScheduledEventService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => http.verify());

    it('lists events under the guild', () => {
        service.list('g1').subscribe();
        const req = http.expectOne(`${base}/guilds/g1/events`);
        expect(req.request.method).toBe('GET');
        req.flush([]);
    });

    it('creates an event under the guild', () => {
        const dto = {title: 'My Event', startsAt: '2026-08-01T10:00:00Z'};
        service.create('g1', dto).subscribe();
        const req = http.expectOne(`${base}/guilds/g1/events`);
        expect(req.request.method).toBe('POST');
        expect(req.request.body).toEqual(dto);
        req.flush({});
    });

    it('updates an event by id, not under the guild', () => {
        service.update('e1', {title: 'x'}).subscribe();
        const req = http.expectOne(`${base}/events/e1`);
        expect(req.request.method).toBe('PATCH');
        req.flush({});
    });

    it('cancels via DELETE on the event', () => {
        service.cancel('e1').subscribe();
        const req = http.expectOne(`${base}/events/e1`);
        expect(req.request.method).toBe('DELETE');
        req.flush(null);
    });

    it('marks and removes interest on the same path with different verbs', () => {
        service.markInterested('e1').subscribe();
        expect(http.expectOne(`${base}/events/e1/interested`).request.method).toBe('POST');
        http.verify();

        service.removeInterest('e1').subscribe();
        expect(http.expectOne(`${base}/events/e1/interested`).request.method).toBe('DELETE');
    });
});
