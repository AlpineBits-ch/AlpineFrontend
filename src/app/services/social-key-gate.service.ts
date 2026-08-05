import {inject, Injectable, signal} from '@angular/core';
import {UserService} from './user.service';
import {OnboardingService} from './onboarding.service';
import {MasterKeyService} from './master-key.service';

/**
 * Stands between an account with no master key and the first action that deserves one.
 *
 * <p><b>What the master key actually is.</b> Not an access control. Nothing in messaging, guilds
 * or calls consults it - MLS signing keys, which are what encrypt messages, are established
 * separately during device registration. Its only consumers are the encrypted device backup, the
 * clean-sign-out check and the post-password-reset repair. An account without one can send and
 * read messages perfectly well; what it cannot do is survive a logout or a reinstall with its
 * history intact.</p>
 *
 * <p>That is why deferring it is safe, and why the prompt this service raises talks about losing
 * history rather than about being locked out. A dialog claiming "you need this to chat" would be
 * false, and the user would find that out the first time they cancelled it.</p>
 *
 * <p>This service owns the single key-setup dialog's visibility so the launch-time path
 * ({@link promptNow}) and the deferred path ({@link require}) drive one instance rather than two
 * competing ones.</p>
 *
 * <p><b>Silent where there is no key engine.</b> Every step of the ceremony this gate raises is a
 * Tauri command, so outside Tauri it cannot be completed at any price - `generate_recovery_code`
 * rejects before the first screen has been left, and the dialog reports "Could not generate a
 * recovery code. Please try again." forever. Raised in front of an action, it is a dead end whose
 * only exit is the "Not now" that cancels what the user asked for; raised at launch, it is
 * `[closable]="false"` and has no exit at all. So both entry points ask
 * {@link MasterKeyService.isAvailable} first - see {@link isSatisfied}.</p>
 */
@Injectable({providedIn: 'root'})
export class SocialKeyGateService {
    private userService = inject(UserService);
    private onboarding = inject(OnboardingService);
    private masterKey = inject(MasterKeyService);

    readonly dialogVisible = signal(false);
    /** Launch-time setup has no way out, as it always has. A deferred prompt must have one. */
    readonly dismissible = signal(false);

    /**
     * Set the moment setup reports success, and consulted by {@link isSatisfied} alongside the
     * fetched user.
     *
     * <p>It exists so a caller retrying immediately after the dialog closes is not told to set up
     * a key it just wrote. The alternative - writing a placeholder envelope into `self` - would put
     * a fabricated `encryptedMasterKey` in front of every other reader of that field, including
     * the sign-out path that tries to *decrypt* it.</p>
     */
    private readonly keyWritten = signal(false);

    /** Callers parked on {@link require}, all released together by whichever way the dialog ends. */
    private waiting: ((allowed: boolean) => void)[] = [];
    /** Whether the open dialog was raised by a gated action, and so should record the interest. */
    private raisedByGate = false;

    /**
     * Synchronous, no I/O, safe to call on every keystroke-adjacent path.
     *
     * <p>Fails open on an unloaded `self`: the launch sequence fetches it before any gated surface
     * is reachable, so a null here is not a state worth blocking a send over.</p>
     *
     * <p><b>And fails open where the key engine does not exist</b>, which is the same judgement
     * applied to a harder case. The question this method answers is "may the caller proceed", not
     * "does the account hold a key" - and a build with no engine can never answer the second one
     * yes, however long it blocks. Gating on it there does not defer the setup, it forbids the
     * action: creating a guild and sending a message become impossible in a browser, and the user
     * is shown a ceremony that fails at its first step with a message inviting them to try again.
     * Nothing is protected by that. The master key is not an access control, and a build with no
     * engine also has no MLS, no local key store and no device backup - so there is no encrypted
     * history for it to have kept, and none is lost by proceeding. The ask returns, correctly, the
     * first time the account is opened somewhere that can actually do it.</p>
     */
    isSatisfied(): boolean {
        if (!this.masterKey.isAvailable()) return true;
        if (this.keyWritten()) return true;
        const user = this.userService.self();
        if (!user) return true;
        return !!user.encryptedMasterKey;
    }

    /**
     * Resolves true if the caller may proceed.
     *
     * <p>False means the user backed out, and the caller must do nothing at all - not a partial
     * write, not an optimistic local echo. The whole affordance of this gate is that cancelling
     * costs nothing.</p>
     */
    require(): Promise<boolean> {
        if (this.isSatisfied()) return Promise.resolve(true);
        return new Promise<boolean>(resolve => {
            this.waiting.push(resolve);
            this.raisedByGate = true;
            this.dismissible.set(true);
            this.dialogVisible.set(true);
        });
    }

    /**
     * The launch-time prompt, for an account that asked for the messaging half up front. Same
     * dialog, no escape hatch, no action waiting behind it.
     *
     * <p>Does nothing without a key engine, and that case is worse than the deferred one rather
     * than merely equivalent: this dialog is `[closable]="false"` and offers no "Not now", so a
     * browser session that reached it would sit on an uncompletable ceremony over the whole shell
     * with no way forward and no way back. See {@link isSatisfied}.</p>
     */
    promptNow(): void {
        if (!this.masterKey.isAvailable()) return;
        this.raisedByGate = false;
        this.dismissible.set(false);
        this.dialogVisible.set(true);
    }

    onSetupComplete(): void {
        this.keyWritten.set(true);
        // Reconciles the real envelope in the background. Nothing waits on it - the flag above is
        // what unblocks the retrying caller - but leaving `self` reporting no master key would
        // strand every other reader of that field on stale state until the next launch.
        this.userService.getSelf().subscribe({
            error: err => console.error('Could not refresh the user after key setup', err),
        });

        if (this.raisedByGate) {
            // Best-effort. The key is written, which is the part that matters; a failed interest
            // update only means the picker's stored answer lags, and the next successful write
            // reconciles it.
            void this.onboarding.addSocialInterest().catch(err =>
                console.error('Could not record the social interest after key setup', err));
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
