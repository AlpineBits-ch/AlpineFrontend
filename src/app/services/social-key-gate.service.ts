import {inject, Injectable, signal} from '@angular/core';
import {UserService} from './user.service';
import {OnboardingService} from './onboarding.service';
import {MasterKeyService} from './master-key.service';
import {FirstRunService} from './first-run.service';

/** Stands between an account with no master key and the first action that deserves one. */
@Injectable({providedIn: 'root'})
export class SocialKeyGateService {
    private userService = inject(UserService);
    private onboarding = inject(OnboardingService);
    private masterKey = inject(MasterKeyService);
    private firstRun = inject(FirstRunService);

    /** Set the moment setup reports success, so a caller retrying is not told to set up a key it just wrote. */
    private readonly keyWritten = signal(false);

    /** The run raised by a gated action, shared by every caller parked behind it. */
    private gateRun: Promise<boolean> | null = null;

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

        this.gateRun ??= this.firstRun.open({keyRequired: true}).then(allowed => {
            this.gateRun = null;
            if (allowed) this.onSetupComplete(true);
            return allowed;
        });
        return this.gateRun;
    }

    /** The launch-time prompt. Does nothing without a key engine: there is no way to finish it. */
    promptNow(): void {
        if (!this.masterKey.isAvailable()) return;
        void this.firstRun.open({keyRequired: true}).then(done => {
            if (done) this.onSetupComplete(false);
        });
    }

    private onSetupComplete(recordInterest: boolean): void {
        this.keyWritten.set(true);
        // Reconciles the real envelope in the background; nothing waits on it.
        this.userService.getSelf().subscribe({
            error: err => console.error('Could not refresh the user after key setup', err),
        });

        // Only for a run a gated action raised. The launch path already has the picker's answer.
        if (recordInterest) {
            // Best-effort: a failed interest update only means the picker's stored answer lags.
            void this.onboarding
                .addSocialInterest()
                .catch(err => console.error('Could not record the social interest after key setup', err));
        }
    }
}
