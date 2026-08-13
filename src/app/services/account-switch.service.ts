import {inject, Injectable} from '@angular/core';
import {AccountRegistryService, AccountSlot} from './account-registry.service';
import {DeviceIdentityService} from './device-identity.service';
import {SessionTeardownService} from './session-teardown.service';
import {
    adoptBootstrapTokens,
    BOOTSTRAP_SLOT_ID,
    clearScopedOAuthKeys,
    setActiveSlotId,
} from './scoped-oauth-storage';
import {clearGuildLayoutCache} from './guild-layout-cache';

/** Where a re-entry lands. A bare reload would keep the current route, which is the whole problem. */
export type ReentryTarget = 'overview' | 'authentication';

/**
 * The URL a re-entry navigates to.
 *
 * <p>A path, not a fragment, and that is the entire point of this function existing separately.
 * `reenter` used to set `window.location.hash = '#/authentication'` and then reload, on the stated
 * assumption that the app used hash routing. It does not: `app.config.ts` imports
 * `withHashLocation` and then calls plain `provideRouter(routes)` without it. So the assignment
 * changed only the fragment, the reload landed back on `/overview`, and the router - which reads
 * the path - brought the shell up with no session. That is exactly the "empty app rather than the
 * login screen" this was written to prevent, and signing out hit it every time.</p>
 *
 * <p>Extracted so the shape can be asserted. The production `reenter` is a replaceable field, so
 * every existing test substitutes it and none of them ever executed the broken line.</p>
 */
export function reentryUrl(target: ReentryTarget): string {
    return `/${target}`;
}

/** How the app is re-entered as a different account. Injected so the switch can be tested. */
export interface SwitchEnvironment {
    /**
     * Tears the process down and starts it again at `target`, as whichever slot is now live.
     *
     * <p>The target is explicit because a bare reload keeps the route it was on. Signing out of the
     * last account and reloading in place would boot `MainPageComponent` with no session, which
     * renders as an empty app rather than as the login screen.</p>
     *
     * <p>It must navigate by <b>path</b>. See {@link reentryUrl} - assuming hash routing here is
     * what made signing out land on an empty shell.</p>
     */
    reenter: (target: ReentryTarget) => void;
    /** True when leaving now would drop a call. */
    callIsLive: () => boolean;
    /** Asks the user whether to leave anyway. */
    confirmLeaveCall: () => Promise<boolean>;
}

/**
 * Moving between the accounts this machine holds.
 *
 * <p><b>One live at a time, and the switch is a reload.</b> Dozens of `providedIn: 'root'` services
 * hold process state that a second account would need its own copy of - three websockets, the
 * WebRTC peers, the Rust `MlsState` handle, the native push-to-talk hook, every store. Tearing all
 * of that down in place has a large surface and no natural place to test it; a reload has one
 * behaviour and one test. It is also what Discord does, which is the model this was asked for.</p>
 *
 * <p>Everything that decides who the app comes back as is written <i>before</i> the reload, and the
 * ordering is the whole correctness argument: the live slot id is the one thing the next boot reads
 * synchronously, so it must be committed before anything can interrupt.</p>
 */
@Injectable({providedIn: 'root'})
export class AccountSwitchService {
    private readonly accounts = inject(AccountRegistryService);
    private readonly deviceIdentity = inject(DeviceIdentityService);
    private readonly teardown = inject(SessionTeardownService);

    /**
     * The reload and the call check, replaceable in tests.
     *
     * <p>A field rather than a constructor parameter so nothing has to provide it in production,
     * where there is exactly one right answer for each.</p>
     */
    environment: SwitchEnvironment = {
        // location.assign, not a hash write plus reload. Assigning a URL that differs in more than
        // the fragment is itself a full document load, so the reload is not merely redundant - it
        // would race the navigation it follows.
        reenter: target => window.location.assign(reentryUrl(target)),
        // Wired to the call service by whoever owns the switcher UI. Defaults to "no call", which
        // is the safe default for the check and the wrong one to leave unwired - see the switcher.
        callIsLive: () => false,
        confirmLeaveCall: async () => true,
    };

    /**
     * Makes another account live and re-enters as it.
     *
     * @returns false when the switch did not happen - an unknown slot, or a declined call prompt.
     */
    async switchTo(slotId: string): Promise<boolean> {
        if (slotId === await this.accounts.activeSlotId()) return true;

        if (this.environment.callIsLive() && !(await this.environment.confirmLeaveCall())) {
            return false;
        }

        // Commits the live slot as part of the write. Nothing after the re-entry runs, so anything
        // the next boot needs has to be persisted by the time this returns.
        if (!await this.accounts.activate(slotId)) return false;

        this.environment.reenter('overview');
        return true;
    }

    /**
     * Leaves for the login screen to sign in as somebody else, keeping this account signed in.
     *
     * <p><b>Deliberately not a sign-out.</b> Nothing is wiped and no tokens are cleared - the live
     * slot is only set aside, so the new account lands on the bootstrap slot, signs in, and gets a
     * slot of its own, and the one it came from is still there to switch back to. Signing out first
     * is the one thing "Add Account" must never do, and it is a single line away from doing it.</p>
     */
    beginAddAccount(): void {
        setActiveSlotId(BOOTSTRAP_SLOT_ID);
        this.environment.reenter('authentication');
    }

    /**
     * Adds a freshly signed-in account and switches to it.
     *
     * <p>Called after the login screen has a session and knows who it belongs to. A duplicate
     * `{serverUrl, userId}` activates the slot that already exists rather than making a second one
     * - two slots for one account would be two device ids, two MLS engines and two halves of one
     * history.</p>
     */
    async adoptSignedInAccount(identity: {
        userId: string;
        serverUrl: string;
        username?: string;
    }): Promise<AccountSlot> {
        const previous = await this.accounts.activeSlotId();
        const slot = await this.accounts.ensureSlot(identity);

        // The sign-in that led here wrote its tokens to the bootstrap slot, because the account was
        // not known until the profile came back. Without moving them the slot that was just created
        // looks at its own empty keys and the session breaks the instant it is established.
        if (previous === BOOTSTRAP_SLOT_ID) adoptBootstrapTokens(slot.id);

        return slot;
    }

    /**
     * Signs one account out and forgets it, leaving the others alone.
     *
     * <p>The local wipe comes first and uses that slot's own device id, so it destroys that
     * account's key material and nothing else. Then the slot's tokens, then the slot. The registry
     * promotes the most recently used survivor, or leaves none live - which is what routes the app
     * back to the login screen.</p>
     */
    async signOutOf(slotId: string): Promise<void> {
        const wasActive = slotId === await this.accounts.activeSlotId();

        // Only resolvable for the live slot: the device id map is read through the active slot, and
        // a background account's key material is deliberately not reachable from here. Removing a
        // background account therefore forgets it and leaves its local stores to be reclaimed the
        // next time it is added, which is the conservative direction - the alternative is a wipe
        // aimed at an id resolved for the wrong account.
        if (wasActive) {
            try {
                await this.teardown.wipeAccount(await this.deviceIdentity.deviceId());
            } catch (err) {
                console.error('Could not fully wipe local MLS state for this account', err);
            }
        }

        clearScopedOAuthKeys(slotId);
        // Next to the tokens, and addressed by slot for the same reason they are: this may be a
        // background account, whose cached guild layout is reachable here and nowhere else. Leaving
        // it behind would keep one account's server and channel names on disk under a slot id that
        // the next `ensureSlot` for the same `{serverUrl, userId}` would hand straight back.
        clearGuildLayoutCache(slotId);
        await this.accounts.remove(slotId);

        if (!wasActive) return;

        // `remove` has already promoted the most recently used survivor, or left none live. The
        // second case is the only one that must not land on `/overview`: there is no session to
        // render it with.
        const next = await this.accounts.activeSlot();
        this.environment.reenter(next ? 'overview' : 'authentication');
    }
}
