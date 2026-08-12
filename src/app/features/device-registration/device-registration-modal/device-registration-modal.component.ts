import {Component, EventEmitter, inject, Input, Output, signal} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {EMPTY, from, of, switchMap, tap, throwError} from 'rxjs';
import {catchError, map} from 'rxjs/operators';
import {UserService} from '../../../services/user.service';
import {DeviceService} from '../../../services/device.service';
import {MlsService} from '../../../services/mls.service';
import {describeCurrentDevice} from '../../../services/device-description';
import {TranslateModule} from '@ngx-translate/core';

type Step = 'input' | 'processing' | 'done';

@Component({
    selector: 'app-device-registration-modal',
    standalone: true,
    imports: [Dialog, Button, InputText, TranslateModule],
    templateUrl: './device-registration-modal.component.html',
    styleUrl: './device-registration-modal.component.css',
})
export class DeviceRegistrationModalComponent {
    @Input() visible = false;
    /** Emits the opaque key handle once the device is registered and keys are persisted. */
    @Output() registered = new EventEmitter<string>();

    protected step = signal<Step>('input');
    protected deviceName = signal('');
    protected errorMsg = signal('');

    private userService = inject(UserService);
    private deviceService = inject(DeviceService);
    private mlsService = inject(MlsService);

    protected onDeviceNameInput(event: Event): void {
        this.deviceName.set((event.target as HTMLInputElement).value);
    }

    protected onRegister(): void {
        const name = this.deviceName().trim();
        if (!name) {
            this.errorMsg.set('Device name is required.');
            return;
        }
        this.errorMsg.set('');
        this.step.set('processing');
        this.register(name);
    }

    private register(deviceName: string): void {
        // Only the type: the name is the one the user just typed, not a derived label.
        //
        // Deliberately the shared decision rather than a form-factor read of its own. This line used
        // to be `isMobile ? Mobile : Desktop`, which could not return `Web` at all - so a browser
        // registered as Desktop, and once `isMobile` started answering the real form factor a phone
        // browser registered as Mobile. The backend picks a push transport off this field, so that
        // would have aimed mobile web at FCM/APNs rather than Web Push. See `describeCurrentDevice`,
        // which decides the host first and explains why `Mobile` is never this client's to send.
        const {deviceType} = describeCurrentDevice();

        const attemptRegistration = () =>
            from(this.mlsService.getOrCreateDeviceIdentifier()).pipe(
                switchMap(deviceId =>
                    this.userService.getSelf().pipe(
                        switchMap(user =>
                            this.mlsService.generateKeyPackages(user.id, 10).pipe(
                                switchMap(batch =>
                                    this.deviceService.registerDevice({
                                        clientDeviceId: deviceId,
                                        deviceName,
                                        deviceType,
                                        identityPublicKey: batch.signingPublicKey,
                                    }).pipe(
                                        // Contract §A. This path has just minted a *fresh* Ed25519
                                        // keypair, so anything the server still holds for this
                                        // device id was sealed to a signing key that no longer
                                        // exists - and a Welcome addressed to one of those packages
                                        // is undecryptable by the very device it was meant for.
                                        //
                                        // The server purges them itself when it sees the key change
                                        // (`identityRotated`), but this runs regardless: it is
                                        // idempotent, and against a server that predates that
                                        // behaviour it is the only thing standing between a
                                        // re-registered device and a stock of dead key packages.
                                        switchMap(device => this.deviceService.resetKeyPackages(deviceId).pipe(
                                            catchError(err => {
                                                console.error(
                                                    'Could not reset stale key packages after minting a new identity',
                                                    err);
                                                return of({deletedCount: 0});
                                            }),
                                            map(() => device),
                                        )),
                                        switchMap(() => this.mlsService.persistSigningKey(deviceId, batch, user.id)),
                                        map(() => batch.keyHandle),
                                    ),
                                ),
                            ),
                        ),
                    ),
                )
            );

        attemptRegistration().pipe(
            catchError((firstError) => {
                console.warn('First registration attempt failed. Retrying...', firstError);

                return from(this.mlsService.deleteDeviceIdentifier()).pipe(
                    switchMap(() => attemptRegistration()),
                    catchError((secondError) => {
                        return throwError(() => secondError);
                    })
                );
            }),
            tap(keyHandle => {
                this.step.set('done');
                this.mlsService.keyHandle.set(keyHandle);
                setTimeout(() => this.registered.emit(keyHandle), 1600);
            }),
            catchError(() => {
                this.errorMsg.set('Registration failed. Please try again.');
                this.step.set('input');
                return EMPTY;
            }),
        ).subscribe();
    }
}
