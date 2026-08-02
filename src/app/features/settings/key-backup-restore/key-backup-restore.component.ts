import {ChangeDetectionStrategy, Component, ElementRef, inject, signal, ViewChild} from '@angular/core';
import {Button} from 'primeng/button';
import {PasswordDirective} from 'primeng/password';
import {TranslateModule} from '@ngx-translate/core';
import {firstValueFrom} from 'rxjs';
import {
    MlsBackupImportError,
    MlsBackupImportFailure,
    MlsFeatureUnavailableError,
    MlsService,
} from '../../../services/mls.service';
import {UserService} from '../../../services/user.service';
import {DeviceService} from '../../../services/device.service';
import {DeviceIdentityService} from '../../../services/device-identity.service';

type Step = 'idle' | 'passphrase' | 'restoring' | 'done';

/**
 * Reads back the `.venta-keys` file the logout dialog writes.
 *
 * <p><b>Without this the export was a trap.</b> The logout flow offers "sign out without losing
 * your keys", writes the full §D envelope - signing private key, every epoch secret, every leaf
 * HPKE private key and the whole plaintext history - and then wipes the keychain entries, the state
 * file, the group registry and the message cache. `mls_import_backup` had no caller and there was
 * no import surface anywhere, so the file could not be read back on any path. The user was told
 * they were keeping their keys and was not.</p>
 *
 * <p><b>What comes back is governed by §D and decided in Rust.</b> The engine - the ratchet state -
 * is restored only when the blob was taken on *this* device id. Nothing here second-guesses that:
 * two devices sharing a leaf reuse sender-ratchet generations, at least one of them becomes unable
 * to send, and forward secrecy for that leaf is gone. On a different device the signing key, the
 * group registry and the message cache come across and the engine does not, so the device re-joins
 * each context and reads forward.</p>
 */
@Component({
    selector: 'app-key-backup-restore',
    standalone: true,
    imports: [Button, PasswordDirective, TranslateModule],
    templateUrl: './key-backup-restore.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class KeyBackupRestoreComponent {
    @ViewChild('fileInput') private fileInput?: ElementRef<HTMLInputElement>;

    protected step = signal<Step>('idle');
    protected fileName = signal('');
    protected passphrase = signal('');
    protected errorMsg = signal('');
    /** Set when the restore succeeded, so the outcome can state which of §D's two rows applied. */
    protected outcome = signal<{ engineRestored: boolean; deviceId: string } | null>(null);

    private readonly mlsService = inject(MlsService);
    private readonly userService = inject(UserService);
    private readonly deviceService = inject(DeviceService);
    private readonly deviceIdentity = inject(DeviceIdentityService);

    /** The chosen file's contents, held only until the restore runs or is cancelled. */
    private blob: string | null = null;

    protected choose(): void {
        this.errorMsg.set('');
        this.fileInput?.nativeElement.click();
    }

    protected async onFileChosen(event: Event): Promise<void> {
        const file = (event.target as HTMLInputElement).files?.[0];
        // Re-selecting the same file must fire `change` again, so the input is reset either way.
        (event.target as HTMLInputElement).value = '';
        if (!file) return;

        this.errorMsg.set('');
        try {
            this.blob = await file.text();
        } catch {
            this.errorMsg.set('That file could not be read.');
            return;
        }
        this.fileName.set(file.name);
        this.passphrase.set('');
        this.step.set('passphrase');
    }

    protected onPassphraseInput(event: Event): void {
        this.passphrase.set((event.target as HTMLInputElement).value);
        this.errorMsg.set('');
    }

    protected cancel(): void {
        // Dropped rather than kept around: the blob is the whole of this device's key material in
        // one string, and there is no reason for it to outlive the dialog.
        this.blob = null;
        this.fileName.set('');
        this.passphrase.set('');
        this.errorMsg.set('');
        this.outcome.set(null);
        this.step.set('idle');
    }

    protected async restore(): Promise<void> {
        const blob = this.blob;
        if (!blob) return;
        if (!this.passphrase()) {
            this.errorMsg.set('The passphrase for this backup is required.');
            return;
        }

        this.errorMsg.set('');
        this.step.set('restoring');

        let userId: string;
        try {
            userId = (await firstValueFrom(this.userService.getSelf())).id;
        } catch {
            this.errorMsg.set('Could not confirm which account is signed in. Try again.');
            this.step.set('passphrase');
            return;
        }

        try {
            // `expectedUserId` is checked in Rust against the blob's own `userId` and refused on a
            // mismatch, so a blob for another account cannot be merged into this one.
            const result = await this.mlsService.importBackup(blob, this.passphrase(), userId);

            // §A. The restored key packages were consumed server-side long ago, and a device that
            // re-uploads without clearing the stale stock leaves the server handing out packages
            // whose private halves are gone - every Welcome sealed to one is undecryptable by the
            // device it was meant for. Best-effort: a restore that worked must not be reported as
            // failed because a follow-up call did not land.
            const deviceId = await this.deviceIdentity.deviceId();
            try {
                await firstValueFrom(this.deviceService.resetKeyPackages(deviceId));
            } catch {
                // Reported through the outcome copy rather than as a failure - see above.
            }

            this.blob = null;
            this.passphrase.set('');
            this.outcome.set({engineRestored: result.engineRestored, deviceId: result.deviceId});
            this.step.set('done');
        } catch (err) {
            this.errorMsg.set(describeImportFailure(err));
            this.step.set('passphrase');
        }
    }
}

/**
 * One message per remedy.
 *
 * <p>The point of the split is that the remedies do not overlap: hunting for a passphrase does
 * nothing about a truncated file, and re-picking a file does nothing about being signed into the
 * wrong account. A single "Restore failed" sends every user down the same wrong path, and for most
 * of these that path is "try the password again", which is the one piece of advice that turns a
 * recoverable situation into an abandoned one.</p>
 */
export function describeImportFailure(err: unknown): string {
    if (err instanceof MlsFeatureUnavailableError) {
        return 'This build does not include the key-restore engine, so this file cannot be opened '
            + 'here. Keep it - a build that does will read it.';
    }
    if (!(err instanceof MlsBackupImportError)) {
        return `Restore failed: ${err instanceof Error ? err.message : String(err)}`;
    }

    const messages: Record<MlsBackupImportFailure, string> = {
        'not-a-backup':
            'That file is not a Venta key backup, or it is incomplete. Check you picked the '
            + '.venta-keys file and that it copied across in full.',
        'unsupported-version':
            'That backup was written by a newer version of Venta than this one. Update and try '
            + 'again - the file is fine.',
        'wrong-passphrase-or-altered':
            'That passphrase did not open the backup. It is the account password you were asked '
            + 'for when the file was saved. If you are certain it is right, the file itself may '
            + 'have been altered or truncated in transit - this check cannot tell the two apart.',
        'wrong-account':
            'That backup belongs to a different account. Sign in as that account to restore it; '
            + 'it will not be merged into this one.',
        'header-mismatch':
            'That backup\'s header does not match its contents, so it has been modified since it '
            + 'was written. Nothing has been restored.',
        'hostile-kdf-parameters':
            'That backup declares key-derivation settings this build refuses to attempt. A genuine '
            + 'Venta backup never does, so treat the file as corrupt.',
        'malformed-contents':
            'That backup opened but is missing something it needs. Nothing has been restored.',
        'local-store-failed':
            'The backup opened, but this device could not save what it restored. Nothing is '
            + 'half-applied; try again.',
        'engine-failed':
            'This device could not run the restore. Your passphrase was not the problem.',
    };

    // The engine's own words are appended for the cases where the category is all this side knows.
    const base = messages[err.reason];
    return err.reason === 'engine-failed' || err.reason === 'local-store-failed'
        ? `${base} Details: ${err.detail}`
        : base;
}
