import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection, signal} from '@angular/core';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {MessageService} from 'primeng/api';
import {of} from 'rxjs';
import {provideFakePlatform} from '../../../platform/testing/provide-fake-platform';
import {PlatformHost} from '../../../platform/host';
import {DeviceIdentityService} from '../../../services/device-identity.service';
import {ProfileService} from '../../../services/profile.service';
import {RealtimeConnectionService} from '../../../services/realtime-connection.service';
import {SettingsUiService} from '../../../services/settings-ui.service';
import {UserService} from '../../../services/user.service';
import {UserDto} from '../../../dtos/response/UserDto';
import {PaymentHandleApiService} from '../payment-handle-api.service';
import {PaymentHandleDirectory} from '../payment-handle.dto';
import {PaymentHandleService} from '../payment-handle.service';
import {PaymentHandlesEditorComponent} from './payment-handles-editor.component';
import en from '../../../../assets/i18n/locales/en.json';

const GUILD = 'guild_1';

function directory(sharingPhoneNumber = false): PaymentHandleDirectory {
    return {
        guildId: GUILD,
        deviceId: 'device_1',
        memberRosterVersion: 3,
        members: [],
        phoneNumbers: [],
        sharingPhoneNumber,
    };
}

interface Harness {
    fixture: ComponentFixture<PaymentHandlesEditorComponent>;
    /** The plaintext phone-number opt-in. Needs no key, so it must survive every host. */
    phoneCard: () => HTMLElement | null;
    /** The switch inside it, so "rendered" can be told from "rendered and usable". */
    phoneSwitch: () => HTMLElement | null;
    /** The seal/delete row. Present only where a blob can actually be written. */
    sealActions: () => HTMLElement | null;
    addButton: () => HTMLElement | null;
    unavailableNote: () => HTMLElement | null;
    setPhoneSharing: ReturnType<typeof vi.fn>;
}

/**
 * Stands the real component up against the real {@link PaymentHandleService} and the real capability
 * set for `host`.
 */
function setup(host: PlatformHost, options: {phoneNumber?: string | null} = {}): Harness {
    const setPhoneSharing = vi.fn(() => of({guildId: GUILD, sharingPhoneNumber: true}));

    TestBed.configureTestingModule({
        imports: [PaymentHandlesEditorComponent, TranslateModule.forRoot()],
        providers: [
            provideZonelessChangeDetection(),
            provideFakePlatform({host}),
            MessageService,
            {
                provide: PaymentHandleApiService,
                useValue: {directory: () => of(directory()), setPhoneSharing},
            },
            // The feature attaches its own replication handler on the first read.
            {provide: RealtimeConnectionService, useValue: {on: () => void 0}},
            {provide: ProfileService, useValue: {ownProfile: () => ({userId: 'user_1'})}},
            {provide: DeviceIdentityService, useValue: {deviceId: async () => 'device_1'}},
            {
                provide: UserService,
                useValue: {
                    self: signal({phoneNumber: options.phoneNumber ?? null} as UserDto),
                    getSelf: () => of({} as UserDto),
                },
            },
            {provide: SettingsUiService, useValue: {open: vi.fn()}},
        ],
    });

    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', en);
    translate.use('en');

    const fixture = TestBed.createComponent(PaymentHandlesEditorComponent);
    fixture.componentRef.setInput('guildId', GUILD);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    return {
        fixture,
        phoneCard: () => el.querySelector<HTMLElement>('[data-testid="phone-sharing"]'),
        phoneSwitch: () =>
            el.querySelector<HTMLElement>('[data-testid="phone-sharing"] p-toggleswitch'),
        sealActions: () => el.querySelector<HTMLElement>('[data-testid="seal-actions"]'),
        addButton: () => el.querySelector<HTMLElement>('p-button[icon="pi pi-plus"]'),
        unavailableNote: () => el.querySelector<HTMLElement>('[data-testid="unavailable"]'),
        setPhoneSharing,
    };
}

/** Two things live in this editor and only one of them needs a key. */
describe('PaymentHandlesEditorComponent capability split', () => {
    describe('in a browser', () => {
        it('keeps the phone-number opt-in on screen', () => {
            expect(setup('web').phoneCard()).not.toBeNull();
        });

        it('keeps the switch itself, not just the card around it', () => {
            // The card is mostly explanatory copy. Rendering the words while dropping the control
            // would pass a "is the card there" check and still leave nothing to press.
            expect(setup('web').phoneSwitch()).not.toBeNull();
        });

        it('still writes the opt-in through', async () => {
            const harness = setup('web');
            harness.fixture.componentInstance['setPhoneSharing'](true);
            await harness.fixture.whenStable();

            expect(harness.setPhoneSharing).toHaveBeenCalledWith(GUILD, true);
        });

        it('hides the keychain-dependent editor', () => {
            const harness = setup('web');

            expect(harness.sealActions()).toBeNull();
            expect(harness.addButton()).toBeNull();
        });

        it('says why the sealed half is missing rather than showing an empty list', () => {
            expect(setup('web').unavailableNote()).not.toBeNull();
        });
    });

    describe('on the desktop', () => {
        it('shows the sealed editor', () => {
            const harness = setup('tauri');

            expect(harness.sealActions()).not.toBeNull();
            expect(harness.addButton()).not.toBeNull();
            expect(harness.unavailableNote()).toBeNull();
        });

        it('shows the phone card alongside it', () => {
            expect(setup('tauri').phoneCard()).not.toBeNull();
        });
    });
});

/**
 * The card renders from state that only the directory read fills, so "visible" is not the whole of
 * "working". `load()` used to return early wherever the keychain was absent, which left the switch
 * on screen reading `false` forever no matter what the server said.
 */
describe('PaymentHandleService on a host with no keychain', () => {
    function service(host: PlatformHost, response: PaymentHandleDirectory): PaymentHandleService {
        TestBed.configureTestingModule({
            providers: [
                provideZonelessChangeDetection(),
                provideFakePlatform({host}),
                {
                    provide: PaymentHandleApiService,
                    useValue: {directory: () => of(response)},
                },
                {provide: RealtimeConnectionService, useValue: {on: () => void 0}},
                {provide: ProfileService, useValue: {ownProfile: () => ({userId: 'user_1'})}},
                {provide: DeviceIdentityService, useValue: {deviceId: async () => 'device_1'}},
            ],
        });
        return TestBed.inject(PaymentHandleService);
    }

    it('reads the caller\'s own opt-in out of the directory', async () => {
        const handles = service('web', directory(true));

        await handles.load(GUILD);

        expect(handles.isSharingPhoneNumber(GUILD)).toBe(true);
    });

    it('reports no member handles rather than unreadable ones', async () => {
        // Nothing was tried, so nothing failed. "We could not open Anna's details" is a different
        // and wrong statement from "we did not look".
        const handles = service('web', {
            ...directory(),
            members: [{
                userId: 'user_2',
                ciphertext: 'AA==',
                nonce: 'AA==',
                version: 1,
                memberRosterVersion: 3,
                updatedAt: '2026-08-12T00:00:00Z',
                wrappedKey: 'AA==',
            }],
        });

        await handles.load(GUILD);

        expect(handles.handlesFor(GUILD, 'user_2').status).toBe('none');
    });
});
