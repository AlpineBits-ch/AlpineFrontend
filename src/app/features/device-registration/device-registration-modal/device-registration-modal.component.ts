import {Component, EventEmitter, inject, input, Output, signal} from '@angular/core';
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
    readonly visible = input(false);
    /** Emits the opaque key handle once the device is registered and keys are persisted. */
    @Output() registered = new EventEmitter<string>();

    protected readonly step = signal<Step>('input');
    protected readonly deviceName = signal('');
    protected readonly errorMsg = signal('');

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
        // Only the type: the name is the one the user just typed, not a derived label. Must stay the
        // shared decision, not a form-factor read: the backend picks a push transport off this field,
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

        attemptRegistration()
            .pipe(
                catchError(firstError => {
                    console.warn('First registration attempt failed. Retrying...', firstError);

                    return from(this.mlsService.deleteDeviceIdentifier()).pipe(
                        switchMap(() => attemptRegistration()),
                        catchError(secondError => {
                            return throwError(() => secondError);
                        }),
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
            )
            .subscribe();
    }
}
