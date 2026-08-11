/**
 * The app's own name and version, read from the host once at startup.
 *
 * <p>The failure arms are the point. `version()` is not only an About-page string:
 * `logout-dialog.component.ts` passes it into `MlsService.exportBackup`, so it is stamped into the
 * key-backup envelope. An empty string there is a backup whose origin is unrecorded, which is bad but
 * honest; a stale hardcoded version would be a false record, which is worse - hence "empty on failure"
 * rather than a fallback number.</p>
 */

import {TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection} from '@angular/core';
import {OsInfo} from '../platform/ports/os-info.port';
import {FakeOsInfo} from '../platform/testing/fake-os-info';
import {AppInfoService} from './app-info.service';

/** Lets both constructor promises settle before the signals are read. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function setup(
    configure: (os: FakeOsInfo) => void = () => undefined,
    os: FakeOsInfo = new FakeOsInfo(),
) {
    configure(os);

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideZonelessChangeDetection(),
            {provide: OsInfo, useValue: os},
        ],
    });
    return {service: TestBed.inject(AppInfoService), os};
}

describe('AppInfoService', () => {
    it('publishes the name and version the host reports', async () => {
        const {service} = setup();
        await settle();

        expect(service.productName()).toBe('Venta');
        expect(service.version()).toBe('3.0.195');
    });

    /** The version is hidden rather than wrong: the About page renders it only when non-empty. */
    it('leaves the version empty when the host cannot answer', async () => {
        const {service} = setup(os => {
            os.versionError = new Error('ipc failed');
        });
        await settle();

        expect(service.version()).toBe('');
    });

    /** A missing product name has a safe answer, unlike a version - it is the same on every build. */
    it('falls back to the product name when the host cannot answer', async () => {
        const {service} = setup(os => {
            os.nameError = new Error('ipc failed');
        });
        await settle();

        expect(service.productName()).toBe('Venta');
    });

    /**
     * Nothing may render "undefined" while the host is still being asked - the port is async on both
     * hosts, so there is always at least a microtask where neither answer has arrived.
     */
    it('starts with an empty version and the fallback name', () => {
        const {service} = setup();

        expect(service.version()).toBe('');
        expect(service.productName()).toBe('Venta');
    });

    /** The version reaches the signal verbatim - it is stamped into the key-backup envelope. */
    it('publishes the version string unchanged', async () => {
        const {service} = setup(() => undefined, new FakeOsInfo('web', false, 'Venta', '4.1.0-rc.2'));
        await settle();

        expect(service.version()).toBe('4.1.0-rc.2');
    });
});
