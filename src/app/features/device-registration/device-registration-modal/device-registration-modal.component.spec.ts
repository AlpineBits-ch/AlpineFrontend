/**
 * What this modal tells the server it is.
 *
 * <p><b>The bug this pins.</b> The device type was computed here as `isMobile ? Mobile : Desktop`, a
 * second copy of a decision `describeCurrentDevice()` already makes - and a copy that could not
 * produce {@link DeviceType.Web} at all. A browser therefore registered as Desktop, and once
 * `isMobile` moved from `PlatformService` (false for everything outside Tauri) to `OsInfo` (a real
 * form factor), a phone browser registered as Mobile.</p>
 *
 * <p>The backend picks a push transport off this field and the phone app is a separate Flutter
 * client, so a browser claiming `Mobile` would be aimed at FCM/APNs instead of Web Push and would
 * simply stop receiving notifications, with nothing on either side reporting a fault.</p>
 *
 * <p>The assertion is deliberately "whatever the shared decision says", not a hardcoded `Web`. The
 * value under the runner is `Web` either way, and pinning the literal would pass just as happily
 * against a second copy of the branching that happened to agree today. What must hold is that there
 * is <b>one</b> source of truth - so the expected value is read from it. The four host and
 * form-factor combinations are asserted with literals where that decision lives, in
 * `services/device-description.spec.ts`.</p>
 */
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
