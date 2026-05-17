import {Component, EventEmitter, inject, Input, Output, signal} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PasswordDirective} from 'primeng/password';
import {from, of, switchMap, take} from 'rxjs';
import {TranslateModule} from '@ngx-translate/core';
import {Router} from '@angular/router';
import {AuthService} from '../../../services/auth.service';
import {UserService} from '../../../services/user.service';
import {MasterKeyService} from '../../../services/master-key.service';
import {MlsService} from '../../../services/mls.service';

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
    private router = inject(Router);

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
                return from(this.masterKeyService.decryptMasterKey(user.encryptedMasterKey, this.password()));
            }),
            switchMap(rawKey => {
                const keyB64 = btoa(String.fromCharCode(...rawKey));
                return this.mlsService.exportState(keyB64);
            }),
        ).subscribe({
            next: blob => {
                // TODO: Dominic — cloud backup / additional export targets
                const a = document.createElement('a');
                a.href = `data:application/octet-stream;base64,${blob}`;
                a.download = `alpine-keys-${new Date().toISOString().slice(0, 10)}.enc`;
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

    private clearMlsAndLogout(): void {
        from(this.mlsService.getOrCreateDeviceIdentifier()).pipe(
            switchMap(deviceId => {
                const handle = this.mlsService.keyHandle();
                const unload$ = handle ? this.mlsService.unloadSigningKey(handle) : of(undefined as void);
                return unload$.pipe(
                    switchMap(() => this.mlsService.clearStoredSigningKey(deviceId)),
                    switchMap(() => this.mlsService.clearStorage()),
                    switchMap(() => from(this.mlsService.clearGroupRegistry())),
                );
            }),
        ).subscribe({
            complete: () => this.doLogout(),
            error: () => this.doLogout(),
        });
    }

    private doLogout(): void {
        this.visibleChange.emit(false);
        this.authService.logout();
        this.router.navigate(['/authentication']);
    }
}
