import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection, signal} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {StatusBannerComponent} from './status-banner.component';
import {PlatformStatusService, StatusBarKind} from '../../services/platform-status.service';
import {ExternalLinkService} from '../../services/external-link.service';
import {StatusBannerDto} from '../../dtos/response/status.dto';

const BANNER: StatusBannerDto = {
    title: 'Elevated error rates affecting Sign-in and accounts',
    body: 'Some people may not be able to sign in or create an account. We are investigating.',
    severity: 'warning',
    incidentReference: 'VNT-4KQ7M2XB',
    url: 'https://status.venta.gg/incident?ref=VNT-4KQ7M2XB',
    template: 'elevated_errors',
    componentKey: 'accounts',
};

function setup(
    bar: StatusBarKind | null,
    banner: StatusBannerDto | null = BANNER,
): {
    fixture: ComponentFixture<StatusBannerComponent>;
    text: () => string;
    dismiss: ReturnType<typeof vi.fn>;
    openExternalLink: ReturnType<typeof vi.fn>;
    click: (selector: string) => void;
} {
    const dismiss = vi.fn();
    const openExternalLink = vi.fn();

    TestBed.configureTestingModule({
        imports: [StatusBannerComponent, TranslateModule.forRoot()],
        providers: [
            provideZonelessChangeDetection(),
            {
                provide: PlatformStatusService,
                useValue: {bar: signal(bar), banner: signal(banner), dismiss},
            },
            {provide: ExternalLinkService, useValue: {openExternalLink}},
        ],
    });

    const fixture = TestBed.createComponent(StatusBannerComponent);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    return {
        fixture,
        text: () => host.textContent ?? '',
        dismiss,
        openExternalLink,
        click: selector => host.querySelector<HTMLElement>(selector)!.click(),
    };
}

describe('StatusBannerComponent', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('renders nothing when the platform is fine', () => {
        const {text} = setup(null, null);
        expect(text().trim()).toBe('');
    });

    it('renders the server copy verbatim rather than composing its own sentence', () => {
        const {text} = setup('incident');
        expect(text()).toContain(BANNER.title);
        expect(text()).toContain(BANNER.body);
    });

    it('opens the incident permalink instead of navigating in-app', () => {
        const {click, openExternalLink} = setup('incident');
        click('button');
        expect(openExternalLink).toHaveBeenCalledWith(BANNER.url);
    });

    it('hands dismissal back to the service so the reference and update time are remembered', () => {
        const {click, dismiss} = setup('incident');
        click('button[aria-label]');
        expect(dismiss).toHaveBeenCalledTimes(1);
    });

    it('says it could not check, without an incident to point at', () => {
        const {text} = setup('unverified', null);
        expect(text()).toContain('STATUS.UNVERIFIED_TITLE');
        expect(text()).not.toContain(BANNER.title);
    });

    it('never blocks the app: no overlay, no backdrop, no disabled controls', () => {
        const {fixture} = setup('incident');
        const host = fixture.nativeElement as HTMLElement;
        expect(host.querySelector('[disabled]')).toBeNull();
        expect(host.querySelector('.fixed, .absolute')).toBeNull();
    });
});
