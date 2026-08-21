import {ChangeDetectionStrategy, Component, signal} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideHttpClient} from '@angular/common/http';
import {HttpTestingController, provideHttpClientTesting} from '@angular/common/http/testing';
import {AuthImageDirective} from './auth-image.directive';
import {ApiConfigService} from '../services/api-config.service';

const BASE = 'https://api.test.example';

@Component({
    imports: [AuthImageDirective],
    template: ` <img alt="test" [appAuthSrc]="url()" />`,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
class HostComponent {
    readonly url = signal<string | null>(null);
}

async function setup(): Promise<{
    fixture: ComponentFixture<HostComponent>;
    http: HttpTestingController;
    img: HTMLImageElement;
}> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        imports: [HostComponent],
        providers: [
            provideHttpClient(),
            provideHttpClientTesting(),
            {
                provide: ApiConfigService,
                useValue: {baseUrl: () => BASE, isOwnUrl: (url: string) => url.startsWith(BASE)},
            },
        ],
    });

    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    return {
        fixture,
        http: TestBed.inject(HttpTestingController),
        img: fixture.nativeElement.querySelector('img') as HTMLImageElement,
    };
}

describe('AuthImageDirective', () => {
    /**
     * The bug this directive exists for: the browser fetches a plain `[src]` itself, outside the
     * HTTP stack the token interceptor lives in, so every attachment URL came back 401 and rendered
     * as a broken image. Going through `HttpClient` is the whole point, so that is what is asserted
     * - not merely that some `src` ends up on the element.
     */
    it('fetches an API URL through HttpClient rather than letting the browser load it', async () => {
        const {fixture, http, img} = await setup();

        fixture.componentInstance.url.set(`${BASE}/api/v1/messaging/attachments/a1/thumbnail`);
        fixture.detectChanges();

        const req = http.expectOne(`${BASE}/api/v1/messaging/attachments/a1/thumbnail`);
        expect(req.request.responseType).toBe('blob');
        req.flush(new Blob(['bytes'], {type: 'image/png'}));
        await fixture.whenStable();

        expect(img.src.startsWith('blob:')).toBe(true);
        http.verify();
    });

    /**
     * Embed previews are proxied to another origin, which serves images but no CORS headers. An
     * XHR against those fails where a plain image load succeeds, so they must stay untouched.
     */
    it('assigns a URL from another origin directly, with no request of its own', async () => {
        const {fixture, http, img} = await setup();

        fixture.componentInstance.url.set('https://cdn.example.net/preview.png');
        fixture.detectChanges();
        await fixture.whenStable();

        expect(img.src).toBe('https://cdn.example.net/preview.png');
        http.verify();
    });

    /**
     * Assigning `src = ''` resolves against the document and loads the page as an image, which is
     * drawn as the very glyph this directive removes. An unset URL must leave no `src` behind.
     */
    it('leaves no src attribute when the URL fetch fails', async () => {
        const {fixture, http, img} = await setup();

        fixture.componentInstance.url.set(`${BASE}/api/v1/messaging/attachments/gone/thumbnail`);
        fixture.detectChanges();

        http.expectOne(`${BASE}/api/v1/messaging/attachments/gone/thumbnail`).flush(new Blob([]), {
            status: 401,
            statusText: 'Unauthorized',
        });
        await fixture.whenStable();

        expect(img.hasAttribute('src')).toBe(false);
        http.verify();
    });

    it('serves a repeated URL from cache instead of downloading it again', async () => {
        const {fixture, http, img} = await setup();
        const url = `${BASE}/api/v1/messaging/attachments/a1/thumbnail`;

        fixture.componentInstance.url.set(url);
        fixture.detectChanges();
        http.expectOne(url).flush(new Blob(['bytes'], {type: 'image/png'}));
        await fixture.whenStable();

        fixture.componentInstance.url.set('https://cdn.example.net/other.png');
        fixture.detectChanges();
        await fixture.whenStable();

        fixture.componentInstance.url.set(url);
        fixture.detectChanges();
        await fixture.whenStable();

        // No second request for the same URL, and the element is showing an image again.
        expect(img.src.startsWith('blob:')).toBe(true);
        http.verify();
    });
});
