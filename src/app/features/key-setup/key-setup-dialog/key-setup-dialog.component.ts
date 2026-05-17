import {Component, EventEmitter, inject, Input, Output, signal} from '@angular/core';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {PasswordDirective} from 'primeng/password';
import {EntropyModalComponent} from '../entropy-modal/entropy-modal.component';
import {UserService} from '../../../services/user.service';
import {MasterKeyService} from '../../../services/master-key.service';
import {PlatformService} from '../../../services/platform.service';
import {catchError, EMPTY, filter, from, switchMap, take, tap} from 'rxjs';
import {TranslateModule} from '@ngx-translate/core';

type Step = 'password' | 'entropy' | 'processing' | 'done';

@Component({
    selector: 'app-key-setup-dialog',
    standalone: true,
    imports: [Dialog, Button, PasswordDirective, EntropyModalComponent, TranslateModule],
    templateUrl: './key-setup-dialog.component.html',
    styleUrl: './key-setup-dialog.component.css',
})
export class KeySetupDialogComponent {
    @Input() visible = false;
    @Output() setupComplete = new EventEmitter<void>();

    protected step = signal<Step>('password');
    protected password = signal('');
    protected errorMsg = signal('');

    private userService = inject(UserService);
    private masterKeyService = inject(MasterKeyService);
    private platformService = inject(PlatformService);

    private readonly showEntropy =
        !this.platformService.isMobile &&
        window.matchMedia('(pointer: fine)').matches;

    protected onPasswordInput(event: Event): void {
        this.password.set((event.target as HTMLInputElement).value);
    }

    protected onContinue(): void {
        if (!this.password()) {
            this.errorMsg.set('Password is required.');
            return;
        }
        this.errorMsg.set('');
        this.userService.verifyPassword(this.password()).pipe(
            take(1),
            filter(valid => {
                if (!valid) {
                    this.errorMsg.set('Incorrect password. Please try again.');
                }
                return valid;
            }),
        ).subscribe(() => {
            if (this.showEntropy) {
                this.step.set('entropy');
            } else {
                this.execute([]);
            }
        });
    }

    protected onEntropyDone(entropy: number[]): void {
        this.execute(entropy);
    }

    private execute(entropy: number[]): void {
        this.step.set('processing');

        from(this.masterKeyService.setupMasterKey(this.password(), entropy)).pipe(
            switchMap(payload => this.userService.uploadEncryptedMasterKey(payload)),
            tap(() => {
                this.step.set('done');
                setTimeout(() => this.setupComplete.emit(), 1600);
            }),
            catchError(() => {
                this.errorMsg.set('Something went wrong. Please try again.');
                this.step.set('password');
                return EMPTY;
            }),
        ).subscribe();
    }
}
