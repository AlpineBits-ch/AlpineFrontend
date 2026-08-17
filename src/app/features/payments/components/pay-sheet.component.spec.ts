import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection} from '@angular/core';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {of} from 'rxjs';
import {provideFakePlatform} from '../../../platform/testing/provide-fake-platform';
import {PlatformHost} from '../../../platform/host';
import {SecureStore} from '../../../platform/ports/secure-store.port';
import {FakeSecureStore} from '../../../platform/testing/fake-secure-store';
import {DeviceIdentityService} from '../../../services/device-identity.service';
import {ExternalLinkService} from '../../../services/external-link.service';
import {ProfileService} from '../../../services/profile.service';
import {RealtimeConnectionService} from '../../../services/realtime-connection.service';
import {PaymentHandleApiService} from '../payment-handle-api.service';
import {PaymentHandleDirectory, SharedPhoneNumber} from '../payment-handle.dto';
import {PaymentHandleService} from '../payment-handle.service';
import {PaySheetComponent} from './pay-sheet.component';
import en from '../../../../assets/i18n/locales/en.json';

const GUILD = 'guild_1';
const PAYEE = 'user_2';

const PHONE: SharedPhoneNumber = {
    userId: PAYEE,
    phoneNumber: '+41791234567',
    updatedAt: '2026-08-01T00:00:00Z',
};

function directory(phoneNumbers: SharedPhoneNumber[]): PaymentHandleDirectory {
    return {
        guildId: GUILD,
        deviceId: 'device_1',
        memberRosterVersion: 3,
        members: [],
        phoneNumbers,
        sharingPhoneNumber: false,
    };
}

interface Harness {
    fixture: ComponentFixture<PaySheetComponent>;
    /** The plaintext TWINT/phone card. No key opens it, so no host may hide it. */
    phoneAssist: () => HTMLElement | null;
    /** The number itself, so "the card rendered" can be told from "the number is on screen". */
    phoneNumber: () => string | null;
    copyButton: () => HTMLElement | null;
    /** "Payment details can only be opened in the desktop app". */
    unavailableNote: () => HTMLElement | null;
    /** The sealed-state sentence claiming this housemate has recorded nothing. */
    noHandles: () => HTMLElement | null;
    markPaid: () => HTMLElement | null;
}

/** The real component against the real {@link PaymentHandleService} and the real capability set. */
async function setup(
    host: PlatformHost,
    phoneNumbers: SharedPhoneNumber[] = [PHONE],
): Promise<Harness> {
    TestBed.configureTestingModule({
        imports: [PaySheetComponent, TranslateModule.forRoot()],
        providers: [
            provideZonelessChangeDetection(),
            provideFakePlatform({host}),
            MessageService,
            {
                provide: PaymentHandleApiService,
                useValue: {directory: () => of(directory(phoneNumbers))},
            },
            {provide: RealtimeConnectionService, useValue: {on: () => void 0}},
            {provide: ProfileService, useValue: {ownProfile: () => ({userId: 'user_1'})}},
            {provide: DeviceIdentityService, useValue: {deviceId: async () => 'device_1'}},
            {provide: ExternalLinkService, useValue: {openExternalLink: vi.fn()}},
        ],
    });

    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', en);
    translate.use('en');

    const fixture = TestBed.createComponent(PaySheetComponent);
    fixture.componentRef.setInput('guildId', GUILD);
    fixture.componentRef.setInput('payeeUserId', PAYEE);
    fixture.componentRef.setInput('payeeName', 'Anna');
    fixture.componentRef.setInput('amountMinor', 2500);
    fixture.componentRef.setInput('currency', 'CHF');
    fixture.detectChanges();
    // Waited on the service's own state, not on `whenStable()`. The directory read is a promise
    // even when the transport is synchronous, and the desktop path is several awaits deeper than
    // the browser one - so a fixed number of microtask turns settles one host and not the other,
    // which reads as "the card is hidden on the desktop" for a card that is merely late.
    await vi.waitFor(() =>
        expect(TestBed.inject(PaymentHandleService).stateFor(GUILD).loaded).toBe(true));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    return {
        fixture,
        phoneAssist: () => el.querySelector<HTMLElement>('[data-testid="phone-assist"]'),
        phoneNumber: () =>
            el.querySelector<HTMLElement>('[data-testid="phone-number"]')?.textContent?.trim()
            ?? null,
        copyButton: () => el.querySelector<HTMLElement>('[data-testid="phone-assist"] p-button'),
        unavailableNote: () => el.querySelector<HTMLElement>('[data-testid="unavailable"]'),
        noHandles: () => el.querySelector<HTMLElement>('[data-testid="no-handles"]'),
        markPaid: () => el.querySelector<HTMLElement>('[data-testid="pay-sheet"] > div:last-child'),
    };
}

/** Four ways to pay, and only three of them need a key. */
describe('PaySheetComponent capability split', () => {
    describe('in a browser', () => {
        it('still shows the shared phone number', async () => {
            const harness = await setup('web');

            expect(harness.phoneAssist()).not.toBeNull();
            // Grouped for reading aloud, which is what it is for.
            expect(harness.phoneNumber()).toContain('79');
        });

        it('keeps the copy button, which is the whole of the TWINT flow', async () => {
            // TWINT cannot be deep-linked by anybody outside a merchant contract, so a card with
            // the number and no way to take it is a card that does nothing.
            expect((await setup('web')).copyButton()).not.toBeNull();
        });

        it('hides the sealed half and says where it can be read', async () => {
            const harness = await setup('web');

            expect(harness.unavailableNote()).not.toBeNull();
            expect(harness.fixture.nativeElement.querySelector('[data-testid="qr-section"]'))
                .toBeNull();
            expect(harness.fixture.nativeElement.querySelector('[data-testid="handle-value"]'))
                .toBeNull();
        });

        it('never claims the housemate recorded nothing', async () => {
            // The branch the blanket gate existed to keep out. It is a false statement about
            // somebody else, and on web it would be false about everybody.
            expect((await setup('web')).noHandles()).toBeNull();
        });

        it('still offers "I have paid this"', async () => {
            // Outside both gates already, and must stay there: somebody may have paid in cash.
            expect((await setup('web')).markPaid()).not.toBeNull();
        });

        it('shows nothing at all when no number was shared', async () => {
            // Silence, not a sentence. "Anna hasn't shared her number" asserts that Anna has one,
            // and the server deliberately cannot tell us whether she does.
            const harness = await setup('web', []);

            expect(harness.phoneAssist()).toBeNull();
            expect(harness.unavailableNote()).not.toBeNull();
        });
    });

    describe('on the desktop', () => {
        it('shows the phone assist alongside the sealed half', async () => {
            expect((await setup('tauri')).phoneAssist()).not.toBeNull();
        });

        it('reaches the sealed states rather than the browser note', async () => {
            const harness = await setup('tauri');

            expect(harness.unavailableNote()).toBeNull();
        });

        /**
         * The desktop half of the same defect. The card used to be nested inside
         * `@case ('available')`, so a housemate who shared a number and no bank details had their
         * number hidden on the desktop too.
         */
        it('shows a number for a housemate with no sealed handles', async () => {
            const harness = await setup('tauri');

            expect(harness.phoneAssist()).not.toBeNull();
            // And the sentence that would contradict it is withheld, rather than sitting above a
            // number the payer can use.
            expect(harness.noHandles()).toBeNull();
        });

        it('does say so when there is genuinely nothing', async () => {
            expect((await setup('tauri', [])).noHandles()).not.toBeNull();
        });
    });

    /**
     * The gate is about key material, so the test for it is about key material rather than about a
     * host name. Showing a phone number on web must not have cost a reach for the device seed - the
     * whole reason the sealed half stays desktop-only is that a browser has nowhere safe to keep
     * one, and a read is the first step of using it.
     */
    describe('key material', () => {
        async function readsAfterLoad(host: PlatformHost): Promise<string[]> {
            await setup(host);
            return (TestBed.inject(SecureStore) as FakeSecureStore).reads;
        }

        it('opens no keychain entry on a host without one', async () => {
            expect(await readsAfterLoad('web')).toEqual([]);
        });

        it('does read the device seed where there is a keychain', async () => {
            // The other direction, so the test above cannot pass because nothing loads at all.
            expect(await readsAfterLoad('tauri')).toContain('alpine_mls_device_1_priv');
        });
    });
});
