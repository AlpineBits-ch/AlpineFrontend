import {inject, Injectable, signal} from '@angular/core';
import {UserService} from './user.service';
import {OnboardingService} from './onboarding.service';
import {MasterKeyService} from './master-key.service';

/** Stands between an account with no master key and the first action that deserves one. Owns the setup dialog. */
@Injectable({providedIn: 'root'})
export class SocialKeyGateService {
    private userService = inject(UserService);
    private onboarding = inject(OnboardingService);
    private masterKey = inject(MasterKeyService);

    readonly dialogVisible = signal(false);
    /** Launch-time setup has no way out; a deferred prompt must have one. */
    readonly dismissible = signal(false);

    /** Set the moment setup reports success, so a caller retrying is not told to set up a key it just wrote. */
    private readonly keyWritten = signal(false);

    /** Callers parked on {@link require}, all released together by whichever way the dialog ends. */
    private waiting: ((allowed: boolean) => void)[] = [];
    /** Whether the open dialog was raised by a gated action, and so should record the interest. */
    private raisedByGate = false;

    /** Synchronous, no I/O. Fails open without a key engine or a loaded `self`: this is not an access control. */
    isSatisfied(): boolean {
        if (!this.masterKey.isAvailable()) return true;
        if (this.keyWritten()) return true;
        const user = this.userService.self();
        if (!user) return true;
        return !!user.encryptedMasterKey;
    }

    /** Resolves true if the caller may proceed. False means do nothing at all: no partial write, no local echo. */
    require(): Promise<boolean> {
        if (this.isSatisfied()) return Promise.resolve(true);
        return new Promise<boolean>(resolve => {
            this.waiting.push(resolve);
            this.raisedByGate = true;
            this.dismissible.set(true);
            this.dialogVisible.set(true);
        });
    }

    /** The launch-time prompt: `[closable]="false"`, so it must do nothing without a key engine. */
    promptNow(): void {
        if (!this.masterKey.isAvailable()) return;
        this.raisedByGate = false;
        this.dismissible.set(false);
        this.dialogVisible.set(true);
    }

    onSetupComplete(): void {
        this.keyWritten.set(true);
        // Reconciles the real envelope in the background; nothing waits on it.
        this.userService.getSelf().subscribe({
            error: err => console.error('Could not refresh the user after key setup', err),
        });

        if (this.raisedByGate) {
            // Best-effort: a failed interest update only means the picker's stored answer lags.
            void this.onboarding
                .addSocialInterest()
                .catch(err => console.error('Could not record the social interest after key setup', err));
        }

        this.close(true);
    }

    onDismissed(): void {
        this.close(false);
    }

    private close(allowed: boolean): void {
        this.dialogVisible.set(false);
        this.raisedByGate = false;
        const waiting = this.waiting;
        this.waiting = [];
        for (const resolve of waiting) resolve(allowed);
    }
}
