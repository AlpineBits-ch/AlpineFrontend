/** What this modal tells the server it is. */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {of} from 'rxjs';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {DeviceRegistrationModalComponent} from './device-registration-modal.component';
import {UserService} from '../../../services/user.service';
import {DeviceService} from '../../../services/device.service';
import {MlsService} from '../../../services/mls.service';
import {describeCurrentDevice} from '../../../services/device-description';
import {DeviceType} from '../../../dtos/response/user-device.dto';
import {RegisterDeviceDto} from '../../../dtos/request/register-device.dto';
import {OsInfo} from '../../../platform/ports/os-info.port';
import {FakeOsInfo} from '../../../platform/testing/fake-os-info';
import {provideFakePlatform} from '../../../platform/testing/provide-fake-platform';

let registered: RegisterDeviceDto[];

/**
 * @param os what the platform reports about the form factor. The fixed component never reads it -
 *        that is the point - but it has to be *provided* for the mutation check to mean anything:
 *        restore the old `isMobile ? Mobile : Desktop` line and this is what feeds it, so the test
 *        fails on the wrong device type rather than on a missing provider.
 */
function setup(os: OsInfo = new FakeOsInfo('windows', false)): ComponentFixture<DeviceRegistrationModalComponent> {
    registered = [];

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideFakePlatform({OsInfo: os}),
            {
                provide: MlsService,
                useValue: {
                    getOrCreateDeviceIdentifier: async () => 'device-1',
                    deleteDeviceIdentifier: async () => undefined,
                    generateKeyPackages: () => of({
                        signingPublicKey: 'pub', signingPrivateKey: 'priv',
                        keyPackages: [], keyHandle: 'handle-1',
                    }),
                    persistSigningKey: () => of(undefined),
                    keyHandle: {set: vi.fn()},
                },
            },
            {provide: UserService, useValue: {getSelf: () => of({id: 'user-1'})}},
            {
                provide: DeviceService,
                useValue: {
                    registerDevice: (dto: RegisterDeviceDto) => {
                        registered.push(dto);
                        return of({id: 'row-1'});
                    },
                    resetKeyPackages: () => of({deletedCount: 0}),
                },
            },
        ],
    });

    return TestBed.createComponent(DeviceRegistrationModalComponent);
}

/** Drives the one path that posts a registration. `register` is private; the button is the door. */
async function registerAs(fixture: ComponentFixture<DeviceRegistrationModalComponent>) {
    const modal = fixture.componentInstance as never as {
        deviceName: {set(value: string): void};
        onRegister(): void;
    };
    modal.deviceName.set('Ada\'s laptop');
    modal.onRegister();
    await new Promise<void>(resolve => setTimeout(resolve, 0));
}

describe('DeviceRegistrationModalComponent registration payload', () => {
    let fixture: ComponentFixture<DeviceRegistrationModalComponent>;

    beforeEach(() => {
        fixture = setup();
    });

    it('sends the shared device type rather than deciding one of its own', async () => {
        await registerAs(fixture);

        expect(registered).toHaveLength(1);
        expect(registered[0].deviceType).toBe(describeCurrentDevice().deviceType);
    });

    it('registers a browser as Web, which is what the runner is', async () => {
        // Belt and braces on the assertion above: if `describeCurrentDevice()` itself regressed, the
        // delegation test would still pass while both halves were wrong together.
        await registerAs(fixture);

        expect(registered[0].deviceType).toBe(DeviceType.Web);
    });

    it('never registers a browser as Mobile - that value belongs to the Flutter app', async () => {
        // The one that would have caught the push-transport regression on its own. Stated separately
        // from "is Web" because Desktop was the *old* wrong answer and Mobile the new one; a fix that
        // traded one for the other should not look green.
        await registerAs(fixture);

        expect(registered[0].deviceType).not.toBe(DeviceType.Mobile);
    });

    it('still registers a phone browser as Web, whatever the form factor says', async () => {
        // The exact combination that broke: a real phone browser, where `OsInfo.isMobile` is true and
        // honestly so. The device type must not follow it - the transport that reaches this client is
        // Web Push, and a `Mobile` row would be routed at FCM/APNs and receive nothing.
        const phone = setup(new FakeOsInfo('android', true));

        await registerAs(phone);

        expect(registered[0].deviceType).toBe(DeviceType.Web);
    });

    it('still sends the name the user typed, not a derived label', async () => {
        // Only the type comes from the shared description - taking its `deviceName` too would
        // silently discard the input this whole modal exists to collect.
        await registerAs(fixture);

        expect(registered[0].deviceName).toBe('Ada\'s laptop');
    });
});
