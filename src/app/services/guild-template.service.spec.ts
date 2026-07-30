import {TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';

import {GuildTemplateService} from './guild-template.service';
import {ApiConfigService} from './api-config.service';

describe('GuildTemplateService', () => {
    let service: GuildTemplateService;
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
        service = TestBed.inject(GuildTemplateService);
        http = TestBed.inject(HttpTestingController);
    });

    afterEach(() => http.verify());

    it('creates a template from a guild', () => {
        const dto = {name: 'My Template', description: 'A cool layout'};
        service.createFromGuild('g1', dto).subscribe();
        const req = http.expectOne(`${base}/guilds/g1/templates`);
        expect(req.request.method).toBe('POST');
        expect(req.request.body).toEqual(dto);
        req.flush({});
    });

    it('fetches a template preview by id', () => {
        service.get('t1').subscribe();
        const req = http.expectOne(`${base}/templates/t1`);
        expect(req.request.method).toBe('GET');
        req.flush({});
    });

    it('creates a new guild from a template', () => {
        const dto = {name: 'New Guild', description: 'from template'};
        service.useTemplate('t1', dto).subscribe();
        const req = http.expectOne(`${base}/templates/t1/use`);
        expect(req.request.method).toBe('POST');
        expect(req.request.body).toEqual(dto);
        req.flush({});
    });
});
