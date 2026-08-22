import {inject, Injectable} from '@angular/core';
import {from, Observable, of, switchMap} from 'rxjs';
import {catchError, map} from 'rxjs/operators';
import {UserService} from './user.service';
import {DeviceService} from './device.service';
import {MlsService} from './mls.service';
import {describeCurrentDevice} from './device-description';

@Injectable({providedIn: 'root'})
export class DeviceRegistrationService {
    private userService = inject(UserService);
    private deviceService = inject(DeviceService);
    private mlsService = inject(MlsService);

    /**
     * Registers this device and returns the opaque key handle for the batch it minted. Retries
     * exactly once: a first failure deletes the local device identifier and starts over under a
     * fresh one, a second failure throws.
     *
     * @param deviceName the label to register under. Never derived here.
     */
    register(deviceName: string): Observable<string> {
        // Only the type: the name is the caller's, not a derived label. Must stay the shared
        // decision, not a form-factor read: the backend picks a push transport off this field,
        // and `Mobile` is never this client's to send. See `describeCurrentDevice`.
        const {deviceType} = describeCurrentDevice();

        const attemptRegistration = () =>
            from(this.mlsService.getOrCreateDeviceIdentifier()).pipe(
                switchMap(deviceId =>
                    this.userService.getSelf().pipe(
                        switchMap(user =>
                            this.mlsService.generateKeyPackages(user.id, 10).pipe(
                                switchMap(batch =>
                                    this.deviceService
                                        .registerDevice({
                                            clientDeviceId: deviceId,
                                            deviceName,
                                            deviceType,
                                            identityPublicKey: batch.signingPublicKey,
                                        })
                                        .pipe(
                                            // Contract §A: this path just minted a fresh keypair, so any
                                            // key package the server still holds is sealed to a dead
                                            // key. Idempotent, and runs regardless of `identityRotated`.
                                            switchMap(device =>
                                                this.deviceService.resetKeyPackages(deviceId).pipe(
                                                    catchError(err => {
                                                        console.error(
                                                            'Could not reset stale key packages after minting a new identity',
                                                            err,
                                                        );
                                                        return of({deletedCount: 0});
                                                    }),
                                                    map(() => device),
                                                ),
                                            ),
                                            switchMap(() =>
                                                this.mlsService.persistSigningKey(deviceId, batch, user.id),
                                            ),
                                            map(() => batch.keyHandle),
                                        ),
                                ),
                            ),
                        ),
                    ),
                ),
            );

        return attemptRegistration().pipe(
            catchError(firstError => {
                console.warn('First registration attempt failed. Retrying...', firstError);

                // The delete comes first: the retry has to run under a new identifier, not the one
                // the failed attempt already spent.
                return from(this.mlsService.deleteDeviceIdentifier()).pipe(
                    switchMap(() => attemptRegistration()),
                );
            }),
            map(keyHandle => {
                this.mlsService.keyHandle.set(keyHandle);
                return keyHandle;
            }),
        );
    }
}
