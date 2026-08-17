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

/** The URL a re-entry navigates to: a path, never a fragment. The app does not use hash routing, so a `#/...` write lands back on `/overview` with no session. */
export function reentryUrl(target: ReentryTarget): string {
    return `/${target}`;
}

/** How the app is re-entered as a different account. Injected so the switch can be tested. */
export interface SwitchEnvironment {
    /** Tears the process down and starts it again at `target`, which must be navigated to by path. See {@link reentryUrl}. */
    reenter: (target: ReentryTarget) => void;
    /** True when leaving now would drop a call. */
    callIsLive: () => boolean;
    /** Asks the user whether to leave anyway. */
    confirmLeaveCall: () => Promise<boolean>;
}

/**
 * Moving between the accounts this machine holds: one live at a time, and the switch is a reload.
 * Everything deciding who the app comes back as must be written before the reload, live slot id first.
 */
@Injectable({providedIn: 'root'})
export class AccountSwitchService {
    private readonly accounts = inject(AccountRegistryService);
    private readonly deviceIdentity = inject(DeviceIdentityService);
    private readonly teardown = inject(SessionTeardownService);

    /** The reload and the call check, replaceable in tests. */
    environment: SwitchEnvironment = {
        // location.assign, not a hash write plus reload: assigning a differing path is itself a full load.
        reenter: target => window.location.assign(reentryUrl(target)),
        // Wired to the call service by whoever owns the switcher UI; defaults to "no call".
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

        // Commits the live slot as part of the write; nothing after the re-entry runs.
        if (!await this.accounts.activate(slotId)) return false;

        this.environment.reenter('overview');
        return true;
    }

    /** Leaves for the login screen to sign in as somebody else. Never a sign-out: nothing is wiped and no tokens are cleared, the live slot is only set aside. */
    beginAddAccount(): void {
        setActiveSlotId(BOOTSTRAP_SLOT_ID);
        this.environment.reenter('authentication');
    }

    /** Adds a freshly signed-in account and switches to it. A duplicate `{serverUrl, userId}` reuses its slot: two slots for one account would be two device ids and two MLS engines. */
    async adoptSignedInAccount(identity: {
        userId: string;
        serverUrl: string;
        username?: string;
    }): Promise<AccountSlot> {
        const previous = await this.accounts.activeSlotId();
        const slot = await this.accounts.ensureSlot(identity);

        // The sign-in wrote its tokens to the bootstrap slot; without moving them the new slot has empty keys.
        if (previous === BOOTSTRAP_SLOT_ID) adoptBootstrapTokens(slot.id);

        return slot;
    }

    /** Signs one account out and forgets it: the wipe runs first with that slot's own device id, so it destroys that account's key material and nothing else. */
    async signOutOf(slotId: string): Promise<void> {
        const wasActive = slotId === await this.accounts.activeSlotId();

        // Only ever the live slot: the device id map is read through the active slot, so wiping a
        // background account would aim at an id resolved for the wrong account. Key material must
        // never cross accounts, so a background account is forgotten rather than wiped.
        if (wasActive) {
            try {
                await this.teardown.wipeAccount(await this.deviceIdentity.deviceId());
            } catch (err) {
                console.error('Could not fully wipe local MLS state for this account', err);
            }
        }

        clearScopedOAuthKeys(slotId);
        // Addressed by slot, like the tokens: a background account's cached layout is reachable here
        // and nowhere else, and the next `ensureSlot` for the same account hands that slot id back.
        clearGuildLayoutCache(slotId);
        await this.accounts.remove(slotId);

        if (!wasActive) return;

        // `remove` promoted the most recently used survivor, or left none live; the second case must
        // not land on `/overview`, because there is no session to render it with.
        const next = await this.accounts.activeSlot();
        this.environment.reenter(next ? 'overview' : 'authentication');
    }
}
