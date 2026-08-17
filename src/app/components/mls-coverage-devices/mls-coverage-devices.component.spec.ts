import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection, signal} from '@angular/core';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {MlsCoverageDevicesComponent} from './mls-coverage-devices.component';
import {MlsCoverageService, MlsCoverageView} from '../../services/mls-coverage.service';
import en from '../../../assets/i18n/locales/en.json';

const CONTEXT = 'conv-1';

function view(overrides: Partial<MlsCoverageView> = {}): MlsCoverageView {
    return {
        contextId: CONTEXT,
        isChannel: false,
        encrypted: true,
        generation: 2,
        thisDeviceExcluded: false,
        otherOwnDevices: [],
        peerDevices: [],
        unavailable: false,
        ...overrides,
    };
}

/** Renders against the real `en.json`: this component picks between five near-identical strings. */
function setup(coverageView: MlsCoverageView | null, options: {
    ownerNames?: Record<string, string>;
    isChannel?: boolean;
} = {}): {
    fixture: ComponentFixture<MlsCoverageDevicesComponent>;
    text: () => string;
    section: () => HTMLElement | null;
    rows: () => string[];
    unavailable: () => HTMLElement | null;
    refresh: ReturnType<typeof vi.fn>;
    button: () => HTMLButtonElement | null;
} {
    const current = signal(coverageView);
    const refresh = vi.fn(async () => undefined);

    TestBed.configureTestingModule({
        imports: [MlsCoverageDevicesComponent, TranslateModule.forRoot()],
        providers: [
            provideZonelessChangeDetection(),
            {provide: MlsCoverageService, useValue: {coverageOf: () => current(), refresh}},
        ],
    });

    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', en);
    translate.use('en');

    const fixture = TestBed.createComponent(MlsCoverageDevicesComponent);
    fixture.componentRef.setInput('contextId', CONTEXT);
    fixture.componentRef.setInput('ownerNames', options.ownerNames ?? {});
    if (options.isChannel) fixture.componentRef.setInput('isChannel', true);
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    return {
        fixture,
        text: () => (host.textContent ?? '').replace(/\s+/g, ' ').trim(),
        section: () => host.querySelector<HTMLElement>('[data-testid="coverage-devices"]'),
        rows: () => [...host.querySelectorAll('[data-testid="coverage-devices"] > div')]
            .map(el => el.textContent?.replace(/\s+/g, ' ').trim() ?? ''),
        unavailable: () => host.querySelector<HTMLElement>('[data-testid="coverage-unavailable"]'),
        refresh,
        button: () => host.querySelector<HTMLButtonElement>('button'),
    };
}

describe('MlsCoverageDevicesComponent', () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('renders nothing before an answer has arrived', () => {
        const {section, unavailable, text} = setup(null);
        expect(section()).toBeNull();
        expect(unavailable()).toBeNull();
        expect(text()).toBe('');
    });

    it('renders nothing at all for an unencrypted context', () => {
        const {section, unavailable} = setup(view({encrypted: false}));
        expect(section()).toBeNull();
        expect(unavailable()).toBeNull();
    });

    /** Empty lists are not an all-clear, and there is no confirmation line to be had. */
    it('renders nothing when everybody can read it', () => {
        const {section, text} = setup(view());
        expect(section()).toBeNull();
        expect(text()).toBe('');
    });

    it('names another of your own devices, with no action', () => {
        const {section, rows, button} = setup(view({
            otherOwnDevices: [{deviceId: 'd', deviceName: 'Pixel 8', covered: false}],
        }));

        expect(section()).not.toBeNull();
        expect(rows()).toHaveLength(1);
        expect(rows()[0]).toContain("Pixel 8 can't read this conversation");
        expect(rows()[0]).toContain('Open Venta on that device and it will ask to be let back in.');
        // The stranded device has to ask for itself; there is nothing to press here.
        expect(button()).toBeNull();
    });

    it('says channel rather than conversation in a channel', () => {
        const {rows} = setup(
            view({isChannel: true, otherOwnDevices: [{deviceId: 'd', deviceName: 'Pixel 8', covered: false}]}),
            {isChannel: true},
        );

        expect(rows()[0]).toContain("Pixel 8 can't read this channel");
    });

    it('names a peer\'s device after its owner', () => {
        const {rows} = setup(
            view({peerDevices: [{userId: 'usr-2', deviceId: 'p', deviceName: 'iPhone 15'}]}),
            {ownerNames: {'usr-2': 'Alex'}},
        );

        expect(rows()[0]).toContain("Alex's iPhone 15 can't read this conversation");
        expect(rows()[0])
            .toContain("They'll be asked to let it in the next time they open Venta on it.");
    });

    it('drops to the owner alone when the device has no name', () => {
        const {rows} = setup(
            view({peerDevices: [{userId: 'usr-2', deviceId: 'p', deviceName: ''}]}),
            {ownerNames: {'usr-2': 'Alex'}},
        );

        expect(rows()[0]).toContain("Alex's device can't read this conversation");
    });

    it('falls back to the raw user id when the roster has not resolved a name', () => {
        const {rows} = setup(
            view({peerDevices: [{userId: 'usr-9', deviceId: 'p', deviceName: 'iPhone 15'}]}),
            {ownerNames: {'usr-2': 'Alex'}},
        );

        expect(rows()[0]).toContain("usr-9's iPhone 15 can't read this conversation");
    });

    it('lists your own devices before other people\'s', () => {
        const {rows} = setup(view({
            otherOwnDevices: [{deviceId: 'd', deviceName: 'Pixel 8', covered: false}],
            peerDevices: [{userId: 'usr-2', deviceId: 'p', deviceName: 'iPhone 15'}],
        }), {ownerNames: {'usr-2': 'Alex'}});

        expect(rows()).toHaveLength(2);
        expect(rows()[0]).toContain('Pixel 8');
        expect(rows()[1]).toContain("Alex's iPhone 15");
    });

    /** The user came here to ask, so "could not check" is an honest answer with a way to retry. */
    it('offers a muted retry when the list could not be read', () => {
        const {unavailable, text} = setup(view({unavailable: true}));

        expect(unavailable()).not.toBeNull();
        expect(text()).toContain("Couldn't check right now");
        expect(text()).toContain('Try again');
    });

    it('keeps showing what was last known alongside the could-not-check line', () => {
        const {section, unavailable, rows} = setup(view({
            unavailable: true,
            peerDevices: [{userId: 'usr-2', deviceId: 'p', deviceName: 'iPhone 15'}],
        }), {ownerNames: {'usr-2': 'Alex'}});

        expect(section()).not.toBeNull();
        expect(rows()).toHaveLength(1);
        expect(unavailable()).not.toBeNull();
    });

    it('asks again when the retry is pressed', () => {
        const {button, refresh} = setup(view({unavailable: true}));

        button()!.click();

        expect(refresh).toHaveBeenCalledWith(CONTEXT, false);
    });

    /** Fetching belongs to the host screen, not to this component. */
    it('never fetches on its own', () => {
        const {refresh} = setup(view());
        expect(refresh).not.toHaveBeenCalled();
    });
});
