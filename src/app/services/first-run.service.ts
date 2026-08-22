import {inject, Injectable, Signal, signal} from '@angular/core';
import {UserService} from './user.service';
import {OnboardingService} from './onboarding.service';
import {MasterKeyService} from './master-key.service';
import {SignupPasswordHolder} from './signup-password-holder';
import {FirstRunStep, owedSteps} from './first-run-steps';

export interface FirstRunOptions {
    /** A gated action is waiting on a master key, whatever the picker's stored answer was. */
    keyRequired?: boolean;
}

/**
 * The lifecycle of one first-run takeover: what it owes, whether it is up, and the promise the
 * caller who opened it is parked on.
 *
 * The flow itself lives in `FirstRunComponent`. Nothing here talks to the network.
 */
@Injectable({providedIn: 'root'})
export class FirstRunService {
    private readonly users = inject(UserService);
    private readonly onboarding = inject(OnboardingService);
    private readonly masterKey = inject(MasterKeyService);
    private readonly heldPassword = inject(SignupPasswordHolder);

    private readonly shown = signal(false);
    private readonly owed = signal<FirstRunStep[]>([]);

    readonly visible: Signal<boolean> = this.shown.asReadonly();
    /** Snapshotted at {@link open}, so the progress rail cannot resize under someone mid-answer. */
    readonly steps: Signal<FirstRunStep[]> = this.owed.asReadonly();

    private waiting: ((done: boolean) => void)[] = [];

    /** Resolves true once the run has finished and the account may proceed. */
    open(options: FirstRunOptions = {}): Promise<boolean> {
        if (!this.shown()) {
            const steps = this.snapshot(options);
            if (steps.length === 0) return Promise.resolve(true);
            this.owed.set(steps);
            this.shown.set(true);
        }
        return new Promise<boolean>(resolve => this.waiting.push(resolve));
    }

    /** Called by the shell when the last owed step is done. */
    complete(): void {
        this.shown.set(false);
        this.owed.set([]);
        const waiting = this.waiting;
        this.waiting = [];
        for (const resolve of waiting) resolve(true);
    }

    private snapshot(options: FirstRunOptions): FirstRunStep[] {
        const user = this.users.self();
        const onboarded = !this.onboarding.needsOnboarding();
        const steps = owedSteps({
            onboarded,
            // Stored interests are not an answer until the picker has been through, and a gated
            // caller overrides them either way.
            interests: options.keyRequired || !onboarded ? undefined : user?.interests,
            hasMasterKey: !!user?.encryptedMasterKey,
            passwordHeld: this.heldPassword.has(),
        });

        // The key steps are engine calls. A build without one cannot finish them.
        if (!this.masterKey.isAvailable()) return steps.filter(step => step === 'pick');
        return steps;
    }
}
