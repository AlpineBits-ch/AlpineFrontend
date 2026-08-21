import {Component, EventEmitter, inject, input, Output, signal} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PasswordDirective} from 'primeng/password';
import {from, switchMap, take} from 'rxjs';
import {TranslateModule} from '@ngx-translate/core';
import {Router} from '@angular/router';
import {AuthService} from '../../../services/auth.service';
import {UserService} from '../../../services/user.service';
import {MasterKeyService} from '../../../services/master-key.service';
import {MlsFeatureUnavailableError, MlsService} from '../../../services/mls.service';
import {UserTokenService} from '../../../services/user-token.service';
import {AccountRegistryService} from '../../../services/account-registry.service';
import {AccountSwitchService} from '../../../services/account-switch.service';
import {AppInfoService} from '../../../services/app-info.service';

type Step = 'export-prompt' | 'password' | 'no-export-warning' | 'export-unavailable' | 'processing';

@Component({
    selector: 'app-logout-dialog',
    standalone: true,
    imports: [Dialog, Button, PasswordDirective, TranslateModule],
    templateUrl: './logout-dialog.component.html',
    styleUrl: './logout-dialog.component.css',
})
export class LogoutDialogComponent {
    readonly visible = input(false);
    @Output() visibleChange = new EventEmitter<boolean>();

    protected readonly step = signal<Step>('export-prompt');
    protected readonly password = signal('');
    protected readonly errorMsg = signal('');

    private authService = inject(AuthService);
    private userService = inject(UserService);
    private masterKeyService = inject(MasterKeyService);
    private mlsService = inject(MlsService);
    private accounts = inject(AccountRegistryService);
    private switcher = inject(AccountSwitchService);
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

        this.userService
            .verifyPassword(this.password())
            .pipe(take(1))
            .subscribe(valid => {
                if (!valid) {
                    this.errorMsg.set('Incorrect password. Please try again.');
                    this.step.set('password');
                    return;
                }
                this.exportThenLogout();
            });
    }

    /** Sign out knowing no backup was written. */
    protected logoutWithoutExport(): void {
        this.step.set('processing');
        this.clearMlsAndLogout();
    }

    protected skipAndLogout(): void {
        this.step.set('processing');
        this.clearMlsAndLogout();
    }

    private exportThenLogout(): void {
        this.userService
            .getSelf()
            .pipe(
                take(1),
                switchMap(user => {
                    if (!user.encryptedMasterKey) throw new Error('no-key');
                    // The password is only proof of ownership here; the blob is sealed under the
                    // passphrase-derived key inside the Rust command, not under the master key.
                    return from(
                        this.masterKeyService.decryptMasterKey(user.encryptedMasterKey, this.password()),
                    ).pipe(switchMap(() => from(this.exportBackup(user.id))));
                }),
            )
            .subscribe({
                next: blob => {
                    // Must be the full §D envelope, not `exportState`: that covers the openmls provider
                    // store alone, omitting the signing keypair, device id, group registry and cache.
                    const a = document.createElement('a');
                    a.href = `data:application/octet-stream;base64,${btoa(blob)}`;
                    a.download = `venta-keys-${new Date().toISOString().slice(0, 10)}.venta-keys`;
                    a.click();
                    this.clearMlsAndLogout();
                },
                error: (err: unknown) => {
                    // A feature this build does not define is not a failure to retry. Sending the user
                    // back to the password step told them to try again at something that can never
                    // succeed, and the export path is the only way out of this dialog other than
                    // discarding the keys - so it trapped them.
                    if (err instanceof MlsFeatureUnavailableError) {
                        this.step.set('export-unavailable');
                        return;
                    }
                    const msg =
                        err instanceof Error && err.message === 'no-key'
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

    /** The full sign-out: this account's key material, its tokens, and its slot. */
    private clearMlsAndLogout(): void {
        // Before the tokens go: `deregisterToken` is an authenticated call, and it is the reason
        // this device stops receiving push for an account it has left.
        void this.userTokenService.deregisterToken();

        from(this.accounts.activeSlotId())
            .pipe(switchMap(slotId => from(this.switcher.signOutOf(slotId))))
            .subscribe({
                // Either way. A teardown that failed halfway must not strand the user in a session
                // they asked to leave, and the local half is best-effort by construction.
                complete: () => this.doLogout(),
                error: () => this.doLogout(),
            });
    }

    private doLogout(): void {
        this.visibleChange.emit(false);
        // The device row itself is deliberately left alone - deleting it cascades away the MLS
        // key packages *and* the encrypted backup, and logout has already wiped the local signing
        // key, so the row is inert either way. Forgetting a device is an explicit action in
        // settings, where the destruction is chosen rather than implied.
        this.authService.logout();
        this.router.navigate(['/authentication']);
    }
}
