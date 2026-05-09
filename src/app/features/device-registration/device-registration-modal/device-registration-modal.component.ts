import { Component, EventEmitter, inject, Input, Output, signal } from '@angular/core';
import { Dialog } from 'primeng/dialog';
import { Button } from 'primeng/button';
import { InputText } from 'primeng/inputtext';
import { EMPTY, from, switchMap, tap } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { UserService } from '../../../services/user.service';
import { DeviceService } from '../../../services/device.service';
import { MlsService } from '../../../services/mls.service';
import { PlatformService } from '../../../services/platform.service';
import { DeviceType } from '../../../dtos/response/user-device.dto';

type Step = 'input' | 'processing' | 'done';

@Component({
  selector: 'app-device-registration-modal',
  standalone: true,
  imports: [Dialog, Button, InputText],
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
  private platformService = inject(PlatformService);

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
    const deviceType = this.platformService.isMobile ? DeviceType.Mobile : DeviceType.Desktop;

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
                  switchMap(() => this.mlsService.persistSigningKey(deviceId, batch, user.id)),
                  map(() => batch.keyHandle),
                ),
              ),
            ),
          ),
        ),
      ),
      tap(keyHandle => {
        this.step.set('done');
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
