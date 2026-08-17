/** An absent updater must never report "up to date": a `null` check is indistinguishable from a real one. */
import {TestBed} from '@angular/core/testing';
import {provideZonelessChangeDetection} from '@angular/core';
import {Updater} from '../platform/ports/updater.port';
import {FakeUpdater} from '../platform/testing/fake-updater';
import {WebUpdater} from '../platform/web/updater.web';
import {UpdateService} from './update.service';

/** A desktop host holding a release, reporting a download in three steps. */
function offeringUpdater(): FakeUpdater {
    const updater = new FakeUpdater();
    updater.available = {version: '3.1.0', currentVersion: '3.0.195', body: '## Fixed\n- things'};
    updater.progress = [
        {downloaded: 0, total: 400},
        {downloaded: 100, total: 400},
        {downloaded: 400, total: 400},
    ];
    return updater;
}

function setup(updater: Updater): UpdateService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [provideZonelessChangeDetection(), {provide: Updater, useValue: updater}],
    });
    return TestBed.inject(UpdateService);
}

describe('UpdateService on a host that cannot update itself', () => {
    it('reports "unsupported", never "up-to-date"', async () => {
        const service = setup(new WebUpdater());

        // `force` must not be able to conjure a check that cannot happen.
        await service.checkForUpdates(true);

        expect(service.checkStatus()).toBe('unsupported');
        expect(service.checkStatus()).not.toBe('up-to-date');
        expect(service.updateInfo()).toBeNull();
        expect(service.dialogVisible()).toBe(false);
    });

    /** `'unsupported'` is a standing fact about the host, so it must not decay to `'idle'` like the others. */
    it('does not decay back to idle, and stays put across repeated presses', async () => {
        vi.useFakeTimers();
        try {
            const service = setup(new WebUpdater());

            await service.checkForUpdates(true);
            await vi.advanceTimersByTimeAsync(30_000);
            expect(service.checkStatus()).toBe('unsupported');

            await service.checkForUpdates(true);
            expect(service.checkStatus()).toBe('unsupported');
        } finally {
            vi.useRealTimers();
        }
    });

    /** Nothing was checked, so there is nothing to install, and asking must not throw at a caller. */
    it('has nothing to install', async () => {
        const service = setup(new WebUpdater());
        await service.checkForUpdates(true);

        await expect(service.downloadAndInstall()).resolves.toBeUndefined();
        expect(service.isDownloading()).toBe(false);
    });

    /** The counter-case: without it this file passes against a service reporting `'unsupported'` for everything. */
    it('still says "up-to-date" when a real check found nothing', async () => {
        const updater = new FakeUpdater();
        const service = setup(updater);

        await service.checkForUpdates(true);

        expect(updater.checks).toBe(1);
        expect(service.checkStatus()).toBe('up-to-date');
    });
});

describe('UpdateService on a host that can', () => {
    it('opens the dialog with what the port reported', async () => {
        const service = setup(offeringUpdater());

        await service.checkForUpdates(true);

        expect(service.checkStatus()).toBe('idle');
        expect(service.dialogVisible()).toBe(true);
        expect(service.updateInfo()).toEqual({
            version: '3.1.0',
            currentVersion: '3.0.195',
            body: '## Fixed\n- things',
        });
    });

    /** The port hands over a running total and the content length together; the accumulation lives in the adapter. */
    it('tracks download progress off the port callback', async () => {
        const service = setup(offeringUpdater());
        await service.checkForUpdates(true);

        await service.downloadAndInstall();

        expect(service.downloadedBytes()).toBe(400);
        expect(service.totalBytes()).toBe(400);
        expect(service.downloadProgress()).toBe(100);
    });

    /** The debug dialog fabricates an `UpdateInfo` and deliberately does not arm the install button. */
    it('will not install an update nobody checked for', async () => {
        const service = setup(offeringUpdater());
        service.openDebugDialog();

        await service.downloadAndInstall();

        expect(service.isDownloading()).toBe(false);
        expect(service.downloadedBytes()).toBe(0);
    });
});
