import {TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection} from '@angular/core';
import {BrokenImageService} from './broken-image.service';

function setup(): BrokenImageService {
    TestBed.configureTestingModule({providers: [provideZonelessChangeDetection()]});
    return TestBed.inject(BrokenImageService);
}

describe('BrokenImageService', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('treats an untried URL as fine', () => {
        expect(setup().isBroken('https://api.example/banner')).toBe(false);
    });

    it('remembers a URL that failed to load', () => {
        const service = setup();
        service.markBroken('https://api.example/banner');

        expect(service.isBroken('https://api.example/banner')).toBe(true);
    });

    it('keeps the verdict per URL so one profile does not retire another', () => {
        const service = setup();
        service.markBroken('https://api.example/profiles/a/avatar');

        expect(service.isBroken('https://api.example/profiles/b/avatar')).toBe(false);
    });

    it('reports nothing for an absent URL rather than throwing', () => {
        const service = setup();

        expect(service.isBroken(undefined)).toBe(false);
        expect(service.isBroken(null)).toBe(false);
        expect(() => service.markBroken(undefined)).not.toThrow();
    });

    it('clears a URL so a freshly uploaded image gets another chance', () => {
        const service = setup();
        service.markBroken('https://api.example/banner');

        service.clear('https://api.example/banner');

        expect(service.isBroken('https://api.example/banner')).toBe(false);
    });
});
