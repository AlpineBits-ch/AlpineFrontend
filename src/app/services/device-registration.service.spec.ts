import {TestBed} from '@angular/core/testing';
import {firstValueFrom, of, throwError} from 'rxjs';
import {beforeEach, describe, expect, it} from 'vitest';
import {DeviceRegistrationService} from './device-registration.service';
import {UserService} from './user.service';
import {DeviceService} from './device.service';
import {MlsService} from './mls.service';
import {describeCurrentDevice} from './device-description';
import {RegisterDeviceDto} from '../dtos/request/register-device.dto';

let registered: RegisterDeviceDto[];
/** Every stubbed call of the run, in order, so the retry's ordering can be asserted. */
let calls: string[];
let keyHandleSet: string[];

/** @param failRegistrations how many leading `registerDevice` calls reject before one succeeds. */
function setup(failRegistrations = 0): DeviceRegistrationService {
    registered = [];
    calls = [];
    keyHandleSet = [];
    // Mirrors the real thing: the same id comes back until something deletes it.
    let identifier = 1;
    let registrations = 0;
    let batches = 0;

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            {
                provide: MlsService,
                useValue: {
                    getOrCreateDeviceIdentifier: async () => {
                        calls.push('getOrCreateDeviceIdentifier');
                        return `device-${identifier}`;
                    },
                    deleteDeviceIdentifier: async () => {
                        calls.push('deleteDeviceIdentifier');
                        identifier++;
                    },
                    generateKeyPackages: () => {
                        calls.push('generateKeyPackages');
                        return of({
                            signingPublicKey: 'pub',
                            signingPrivateKey: 'priv',
                            keyPackages: [],
                            keyHandle: `handle-${++batches}`,
                        });
                    },
                    persistSigningKey: () => {
                        calls.push('persistSigningKey');
                        return of(undefined);
                    },
                    keyHandle: {set: (value: string) => keyHandleSet.push(value)},
                },
            },
            {provide: UserService, useValue: {getSelf: () => of({id: 'user-1'})}},
            {
                provide: DeviceService,
                useValue: {
                    registerDevice: (dto: RegisterDeviceDto) => {
                        calls.push('registerDevice');
                        registered.push(dto);
                        if (++registrations <= failRegistrations) {
                            return throwError(() => new Error('registration refused'));
                        }
                        return of({id: 'row-1'});
                    },
                    resetKeyPackages: () => {
                        calls.push('resetKeyPackages');
                        return of({deletedCount: 0});
                    },
                },
            },
        ],
    });

    return TestBed.inject(DeviceRegistrationService);
}

describe('DeviceRegistrationService', () => {
    let service: DeviceRegistrationService;

    beforeEach(() => {
        service = setup();
    });

    it('registers with the name it was handed and the shared device type', async () => {
        await firstValueFrom(service.register("Ada's laptop"));

        expect(registered).toHaveLength(1);
        expect(registered[0].deviceName).toBe("Ada's laptop");
        expect(registered[0].deviceType).toBe(describeCurrentDevice().deviceType);
    });

    it('emits the key handle and puts it on the session', async () => {
        const keyHandle = await firstValueFrom(service.register('Ada'));

        expect(keyHandle).toBe('handle-1');
        expect(keyHandleSet).toEqual(['handle-1']);
    });

    it('does not touch the device identifier when the first attempt lands', async () => {
        await firstValueFrom(service.register('Ada'));

        expect(calls).not.toContain('deleteDeviceIdentifier');
        expect(registered).toHaveLength(1);
    });

    it('deletes the device identifier before retrying, and registers again', async () => {
        service = setup(1);

        await firstValueFrom(service.register('Ada'));

        expect(calls.filter(c => c === 'registerDevice')).toHaveLength(2);
        const deleted = calls.indexOf('deleteDeviceIdentifier');
        expect(deleted).toBeGreaterThan(calls.indexOf('registerDevice'));
        expect(deleted).toBeLessThan(calls.lastIndexOf('registerDevice'));
    });

    it('registers the second attempt under a fresh identifier and key package batch', async () => {
        service = setup(1);

        const keyHandle = await firstValueFrom(service.register('Ada'));

        expect(registered[0].clientDeviceId).toBe('device-1');
        expect(registered[1].clientDeviceId).toBe('device-2');
        expect(calls.filter(c => c === 'generateKeyPackages')).toHaveLength(2);
        expect(keyHandle).toBe('handle-2');
        expect(keyHandleSet).toEqual(['handle-2']);
    });

    it('stops after the second failure and does not mint a third keypair', async () => {
        service = setup(2);

        await expect(firstValueFrom(service.register('Ada'))).rejects.toThrow('registration refused');

        expect(calls.filter(c => c === 'registerDevice')).toHaveLength(2);
        expect(calls.filter(c => c === 'generateKeyPackages')).toHaveLength(2);
        expect(calls.filter(c => c === 'deleteDeviceIdentifier')).toHaveLength(1);
        expect(keyHandleSet).toEqual([]);
    });
});
