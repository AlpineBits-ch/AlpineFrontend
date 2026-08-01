import {Component, EventEmitter, inject, Input, Output, signal} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PasswordDirective} from 'primeng/password';
import {catchError, from, of, switchMap, take} from 'rxjs';
import {TranslateModule} from '@ngx-translate/core';
import {Router} from '@angular/router';
import {AuthService} from '../../../services/auth.service';
import {UserService} from '../../../services/user.service';
import {MasterKeyService} from '../../../services/master-key.service';
import {MlsService} from '../../../services/mls.service';
import {UserTokenService} from '../../../services/user-token.service';
import {DeviceService} from '../../../services/device.service';
import {AppInfoService} from '../../../services/app-info.service';

type Step = 'export-prompt' | 'password' | 'no-export-warning' | 'processing';

@Component({
    selector: 'app-logout-dialog',
    standalone: true,
    imports: [Dialog, Button, PasswordDirective, TranslateModule],
    templateUrl: './logout-dialog.component.html',
    styleUrl: './logout-dialog.component.css',
})
export class LogoutDialogComponent {
    @Input() visible = false;
    @Output() visibleChange = new EventEmitter<boolean>();

    protected step = signal<Step>('export-prompt');
    protected password = signal('');
    protected errorMsg = signal('');

    private authService = inject(AuthService);
    private userService = inject(UserService);
    private masterKeyService = inject(MasterKeyService);
    private mlsService = inject(MlsService);
    private deviceService = inject(DeviceService);
    private userTokenService = inject(UserTokenService);
    private router = inject(Router);
    private readonly appInfo = inject(AppInfoService);

    protected onPasswordInput(event: Event): void {
        this.password.set((event.target as HTMLInputElement).value);
    }

    protected chooseExport(): void {
        this.step.set('password');
    }

    protected chooseSkip(): void {
        this.step.set('no-export-warning');
    }

    protected backToPrompt(): void {
        this.password.set('');
        this.errorMsg.set('');
        this.step.set('export-prompt');
    }

    protected close(): void {
        this.step.set('export-prompt');
        this.password.set('');
        this.errorMsg.set('');
        this.visibleChange.emit(false);
    }

    protected submitExport(): void {
        if (!this.password()) {
            this.errorMsg.set('Password is required.');
            return;
        }
        this.errorMsg.set('');
        this.step.set('processing');

        this.userService.verifyPassword(this.password()).pipe(take(1)).subscribe(valid => {
            if (!valid) {
                this.errorMsg.set('Incorrect password. Please try again.');
                this.step.set('password');
                return;
            }
            this.exportThenLogout();
        });
    }

    protected skipAndLogout(): void {
        this.step.set('processing');
        this.clearMlsAndLogout();
    }

    private exportThenLogout(): void {
        this.userService.getSelf().pipe(
            take(1),
            switchMap(user => {
                if (!user.encryptedMasterKey) throw new Error('no-key');
                // The password is only proof of ownership here; the blob is sealed under the
                // passphrase-derived key inside the Rust command, not under the master key.
                return from(this.masterKeyService.decryptMasterKey(user.encryptedMasterKey, this.password()))
                    .pipe(switchMap(() => from(this.exportBackup(user.id))));
            }),
        ).subscribe({
            next: blob => {
                // The full §D envelope, not `exportState`: that covered the openmls provider store
                // alone and omitted the signing keypair, the device id, the group registry and the
                // message cache - which is why the old export could restore precisely nothing, and
                // why this flow used to delete the signing key moments after "backing it up".
                const a = document.createElement('a');
                a.href = `data:application/octet-stream;base64,${btoa(blob)}`;
                a.download = `venta-keys-${new Date().toISOString().slice(0, 10)}.venta-keys`;
                a.click();
                this.clearMlsAndLogout();
            },
            error: (err: unknown) => {
                const msg = err instanceof Error && err.message === 'no-key'
                    ? 'No encryption keys found on this account.'
                    : 'Export failed. Please try again.';
                this.errorMsg.set(msg);
                this.step.set('password');
            },
        });
    }

    /**
     * The local-file export target. Includes the message cache: this is the user's own disk, and
     * plaintext history is the thing they most want back - the cloud target excludes it by default
     * precisely because that tradeoff should not be made silently on their behalf.
     */
    private exportBackup(userId: string): Promise<string> {
        return this.mlsService.exportBackup(this.password(), userId, this.appInfo.version(), true);
    }

    private clearMlsAndLogout(): void {
        from(this.mlsService.getOrCreateDeviceIdentifier()).pipe(
            switchMap(deviceId => {
                const handle = this.mlsService.keyHandle();
                const unload$ = handle ? this.mlsService.unloadSigningKey(handle) : of(undefined as void);
                return unload$.pipe(
                    switchMap(() => this.mlsService.clearStoredSigningKey(deviceId)),
                    switchMap(() => this.mlsService.clearStorage()),
                    switchMap(() => from(this.mlsService.clearGroupRegistry())),
                    switchMap(() => from(this.mlsService.clearMessageCache())),
                    // Contract §A. Without this the server keeps handing out key packages whose
                    // private halves were just deleted, and every Welcome sealed to one of them is
                    // undecryptable by the device it was meant for - including after a fresh login
                    // on this same machine, which keeps its device id.
                    switchMap(() => this.deviceService.resetKeyPackages(deviceId).pipe(
                        catchError(() => of(undefined)),
                    )),
                );
            }),
        ).subscribe({
            complete: () => this.doLogout(),
            error: () => this.doLogout(),
        });
    }

    private doLogout(): void {
        this.visibleChange.emit(false);
        // Fire-and-forget: a failed push cleanup must not strand the user in a session they
        // asked to leave. `deregisterToken` already swallows its own errors.
        //
        // The device row itself is deliberately left alone - deleting it cascades away the MLS
        // key packages *and* the encrypted backup, and logout has already wiped the local signing
        // key, so the row is inert either way. Forgetting a device is an explicit action in
        // settings, where the destruction is chosen rather than implied.
        void this.userTokenService.deregisterToken();
        this.authService.logout();
        this.router.navigate(['/authentication']);
    }
}
