import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection, signal} from '@angular/core';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {MlsUnreadableBannerComponent} from './mls-unreadable-banner.component';
import {MlsHealthService} from '../../services/mls-health.service';
import {describeRelinkOutcome, MlsRelinkStatus} from '../../services/mls-join-request.service';
import {
    MlsAccessRequestState,
    MlsCoverageService,
    MlsCoverageView,
} from '../../services/mls-coverage.service';
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

function setup(options: {
    coverage?: MlsCoverageView | null;
    request?: MlsAccessRequestState;
    isChannel?: boolean;
    accessOfferedElsewhere?: boolean;
} = {}): {
    fixture: ComponentFixture<MlsUnreadableBannerComponent>;
    health: MlsHealthService;
    text: () => string;
    notice: () => HTMLElement | null;
    button: (label: string) => HTMLButtonElement | undefined;
    status: (value: MlsRelinkStatus | null) => void;
    requestAccess: ReturnType<typeof vi.fn>;
    ensure: ReturnType<typeof vi.fn>;
} {
    const coverage = signal(options.coverage ?? null);
    const request = signal<MlsAccessRequestState>(options.request ?? {state: 'idle'});
    const requestAccess = vi.fn();
    const ensure = vi.fn(async () => undefined);

    TestBed.configureTestingModule({
        imports: [MlsUnreadableBannerComponent, TranslateModule.forRoot()],
        providers: [
            provideZonelessChangeDetection(),
            {
                provide: MlsCoverageService,
                useValue: {
                    coverageOf: () => coverage(),
                    requestStateOf: () => request(),
                    ensure,
                    requestAccess,
                },
            },
        ],
    });

    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', en);
    translate.use('en');

    const fixture = TestBed.createComponent(MlsUnreadableBannerComponent);
    fixture.componentRef.setInput('contextId', CONTEXT);
    if (options.isChannel) fixture.componentRef.setInput('isChannel', true);
    if (options.accessOfferedElsewhere) {
        fixture.componentRef.setInput('accessOfferedElsewhere', true);
    }
    fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;

    return {
        fixture,
        health: TestBed.inject(MlsHealthService),
        text: () => host.textContent ?? '',
        notice: () => host.querySelector<HTMLElement>('[data-testid="coverage-notice"]'),
        button: label => [...host.querySelectorAll('button')]
            .find(b => (b.textContent ?? '').includes(label)),
        status: value => {
            fixture.componentRef.setInput('status', value);
            fixture.detectChanges();
        },
        requestAccess,
        ensure,
    };
}

describe('MlsUnreadableBannerComponent', () => {
    beforeEach(() => TestBed.resetTestingModule());

    describe('what this client has observed go wrong', () => {
        it('says nothing while the context is readable', () => {
            const {text} = setup();
            expect(text().trim()).toBe('');
        });

        it('names exclusion rather than a decrypt problem when this device was never admitted', () => {
            const {health, fixture, text} = setup();
            health.recordFailure(CONTEXT, false, 'not-admitted');
            fixture.detectChanges();

            expect(text()).toContain('This device has not been added to the conversation');
        });

        it('reports a failed re-link instead of leaving the button looking like a no-op', () => {
            const {health, fixture, text, status} = setup();
            health.recordFailure(CONTEXT, false, 'not-admitted');
            fixture.detectChanges();

            status(describeRelinkOutcome({
                state: 'failed',
                message: "'device-a' is not one of your registered devices.",
            }));

            expect(text()).toContain('Re-linking failed');
            expect(text()).toContain("'device-a' is not one of your registered devices.");
        });

        it('stays visible after a re-link that only asked to be admitted', () => {
            const {health, fixture, text, status} = setup();
            health.recordFailure(CONTEXT, false, 'not-admitted');
            fixture.detectChanges();

            status(describeRelinkOutcome({state: 'requested', request: {} as never}));

            // The remedy is somebody else approving, so the banner must not read as resolved.
            expect(text()).toContain('This device has not been added to the conversation');
            expect(text()).toContain('Asked to be admitted');
        });
    });

    describe('what the server records about coverage', () => {
        it('asks for coverage when it mounts, which is when the context is opened', () => {
            const {ensure} = setup();
            expect(ensure).toHaveBeenCalledWith(CONTEXT, false);
        });

        it('says nothing before an answer has arrived', () => {
            const {notice, text} = setup();
            expect(notice()).toBeNull();
            expect(text().trim()).toBe('');
        });

        it('says nothing when this device is not the one excluded', () => {
            const {notice} = setup({
                coverage: view({
                    otherOwnDevices: [{deviceId: 'd', deviceName: 'Pixel 8', covered: false}],
                    peerDevices: [{userId: 'u', deviceId: 'p', deviceName: 'iPhone 15'}],
                }),
            });
            // 5b and 5c belong on the encryption screen. Never on top of every conversation.
            expect(notice()).toBeNull();
        });

        it('renders nothing at all for an unencrypted context', () => {
            const {notice} = setup({coverage: view({encrypted: false})});
            expect(notice()).toBeNull();
        });

        it('says nothing when the answer could only report that it could not be read', () => {
            const {notice} = setup({coverage: view({unavailable: true})});
            expect(notice()).toBeNull();
        });

        it('offers the one repair when this device is excluded', () => {
            const {notice, text} = setup({coverage: view({thisDeviceExcluded: true})});

            expect(notice()).not.toBeNull();
            expect(text()).toContain("This device can't read these messages");
            expect(text()).toContain("It wasn't set up for this conversation's encryption.");
            expect(text()).toContain('Older messages will stay unavailable here.');
            expect(text()).toContain('Request access');
        });

        it('says channel rather than conversation in a channel', () => {
            const {text} = setup({coverage: view({thisDeviceExcluded: true}), isChannel: true});

            expect(text()).toContain("It wasn't set up for this channel's encryption.");
            // The title is context-neutral and identical in both.
            expect(text()).toContain("This device can't read these messages");
        });

        /** Both are the same sentence; the observed one names the specific fault and its repair is
         * the more capable, so it wins rather than stacking. */
        it('yields to the observed fault when both apply', () => {
            const {notice, fixture, health, text} = setup({
                coverage: view({thisDeviceExcluded: true}),
            });
            expect(notice()).not.toBeNull();

            health.recordFailure(CONTEXT, false, 'not-admitted');
            fixture.detectChanges();

            expect(notice()).toBeNull();
            expect(text()).toContain('This device has not been added to the conversation');
        });

        /** The channel view's access banner replaces the composer and carries the fingerprint an
         * approver asks for, so it owns this case there. */
        it('stands down where the host already offers access', () => {
            const {notice} = setup({
                coverage: view({thisDeviceExcluded: true}),
                isChannel: true,
                accessOfferedElsewhere: true,
            });

            expect(notice()).toBeNull();
        });

        it('still reports an observed fault the access banner cannot see', () => {
            const {fixture, health, text} = setup({
                coverage: view({thisDeviceExcluded: true}),
                isChannel: true,
                accessOfferedElsewhere: true,
            });

            health.recordFailure(CONTEXT, true, 'downgraded');
            fixture.detectChanges();

            expect(text()).toContain('reported as switched off');
        });

        it('submits the request when the button is pressed', () => {
            const {button, requestAccess} = setup({coverage: view({thisDeviceExcluded: true})});

            button('Request access')!.click();

            expect(requestAccess).toHaveBeenCalledWith(CONTEXT, false);
        });

        it('posts to the channel collection for a channel', () => {
            const {button, requestAccess} = setup({
                coverage: view({thisDeviceExcluded: true}),
                isChannel: true,
            });

            button('Request access')!.click();

            expect(requestAccess).toHaveBeenCalledWith(CONTEXT, true);
        });

        it('becomes a status line, not a spinner, once the request is in', () => {
            const {text, button} = setup({
                coverage: view({thisDeviceExcluded: true}),
                request: {state: 'waiting'},
            });

            expect(text()).toContain('Waiting to be let in');
            expect(text()).toContain('Approve this from another of your devices');
            expect(text()).not.toContain("This device can't read these messages");
            // Nothing left to press: approval can take days, so there is no second thing to try.
            expect(button('Request access')).toBeUndefined();
        });

        it('refuses a second press while the first is in flight', () => {
            const {button} = setup({
                coverage: view({thisDeviceExcluded: true}),
                request: {state: 'submitting'},
            });

            expect(button('Request access')!.disabled).toBe(true);
        });

        it('shows the server\'s own refusal rather than swallowing it', () => {
            const {text} = setup({
                coverage: view({thisDeviceExcluded: true}),
                request: {state: 'failed', message: "'device-here' is not a registered device."},
            });

            expect(text()).toContain("'device-here' is not a registered device.");
        });
    });
});

/**
 * The copy is the feature. It has to be honest that history does not come back, and it has to stay
 * out of the vocabulary that means nothing to the person reading it.
 */
describe('device access copy', () => {
    const strings = en as Record<string, string>;
    const KEYS = Object.keys(strings).filter(k => k.startsWith('DEVICE_ACCESS.'));

    it('matches the contract word for word', () => {
        expect(strings['DEVICE_ACCESS.THIS_DEVICE_TITLE'])
            .toBe("This device can't read these messages");
        expect(strings['DEVICE_ACCESS.THIS_DEVICE_BODY'])
            .toBe("It wasn't set up for this conversation's encryption. "
                + 'Older messages will stay unavailable here.');
        expect(strings['DEVICE_ACCESS.REQUEST']).toBe('Request access');
        expect(strings['DEVICE_ACCESS.WAITING_TITLE']).toBe('Waiting to be let in');
        expect(strings['DEVICE_ACCESS.WAITING_BODY'])
            .toBe('Approve this from another of your devices, '
                + 'or ask someone in this conversation to.');
        expect(strings['DEVICE_ACCESS.OWN_DEVICE_BODY'])
            .toBe('Open Venta on that device and it will ask to be let back in.');
        expect(strings['DEVICE_ACCESS.PEER_DEVICE_BODY'])
            .toBe("They'll be asked to let it in the next time they open Venta on it.");
        expect(strings['DEVICE_ACCESS.UNAVAILABLE']).toBe("Couldn't check right now");
    });

    /** Same sentence, one noun swapped. Anything else would be two pieces of copy to keep in step
     * with the other client. */
    it.each([
        ['DEVICE_ACCESS.THIS_DEVICE_BODY', 'DEVICE_ACCESS.THIS_DEVICE_BODY_CHANNEL'],
        ['DEVICE_ACCESS.WAITING_BODY', 'DEVICE_ACCESS.WAITING_BODY_CHANNEL'],
        ['DEVICE_ACCESS.OWN_DEVICE_TITLE', 'DEVICE_ACCESS.OWN_DEVICE_TITLE_CHANNEL'],
    ])('%s and %s differ only in the noun', (conversationKey, channelKey) => {
        expect(strings[channelKey]).toBe(strings[conversationKey].replace('conversation', 'channel'));
    });

    it.each(['de', 'fr'])('%s carries every key en does', async locale => {
        const translated = (await import(`../../../assets/i18n/locales/${locale}.json`)).default;
        for (const key of KEYS) expect(translated[key], key).toBeTruthy();
    });

    it.each(KEYS)('%s uses no vocabulary from the protocol', key => {
        const banned = /\b(MLS|leaf|leaves|generation|epoch|group|covered|unreachable|key package)\b/i;
        expect(strings[key]).toBeTruthy();
        expect(strings[key]).not.toMatch(banned);
    });

    it.each(KEYS)('%s never says the conversation is insecure', key => {
        expect(strings[key]).not.toMatch(/\b(insecure|not secure|unverified|not verified)\b/i);
    });

    it('never promises history that cannot come back', () => {
        // A device admitted now joins at the current epoch. "We'll sync your messages" is false.
        for (const key of KEYS) {
            expect(strings[key]).not.toMatch(/\b(sync|restore|recover)\b/i);
        }
    });
});
