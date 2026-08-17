import {TestBed} from '@angular/core/testing';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {provideHttpClient} from '@angular/common/http';
import {GuildEmojiService} from './guild-emoji.service';
import {ApiConfigService} from './api-config.service';

const BASE = 'https://api.test.example/api/v1/guild';

function setup() {
    TestBed.configureTestingModule({
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {provide: ApiConfigService, useValue: {baseUrl: () => 'https://api.test.example'}},
        ],
    });
    return {
        service: TestBed.inject(GuildEmojiService),
        ctrl: TestBed.inject(HttpTestingController),
    };
}

describe('GuildEmojiService', () => {
    afterEach(() => TestBed.inject(HttpTestingController).verify());

    it('getEmojis GETs the guild emoji list', () => {
        const {service, ctrl} = setup();
        service.getEmojis('g1').subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/emojis`);
        expect(req.request.method).toBe('GET');
        req.flush([]);
    });

    it('uploadEmoji POSTs multipart form data with name, animated, and file', () => {
        const {service, ctrl} = setup();
        const file = new File(['x'], 'pepega.png', {type: 'image/png'});
        service.uploadEmoji('g1', {name: 'pepega', animated: false, file}).subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/emojis`);
        expect(req.request.method).toBe('POST');
        expect(req.request.body instanceof FormData).toBe(true);
        const body = req.request.body as FormData;
        expect(body.get('name')).toBe('pepega');
        expect(body.get('animated')).toBe('false');
        expect(body.get('file')).toBe(file);
        req.flush({id: 'e1', guildId: 'g1', name: 'pepega', animated: false, createdByUserId: 'u1', createdAt: '2026-07-30T00:00:00Z', imageUrl: 'https://x'});
    });

    it('deleteEmoji DELETEs the emoji by id', () => {
        const {service, ctrl} = setup();
        service.deleteEmoji('g1', 'e1').subscribe();
        const req = ctrl.expectOne(`${BASE}/guilds/g1/emojis/e1`);
        expect(req.request.method).toBe('DELETE');
        req.flush(null);
    });
});
