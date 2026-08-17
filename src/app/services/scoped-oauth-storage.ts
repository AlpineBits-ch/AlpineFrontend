// Type-only on purpose. `OAuthStorage` is an interface and nothing here calls into the library, so
// a value import would put the whole of `angular-oauth2-oidc` into the module graph of every file
// that only wants `activeSlotId()` - which is now the guild layout cache, and through it
// `GuildService` and most of the guild UI.
import type {OAuthStorage} from 'angular-oauth2-oidc';

/**
 * The bootstrap slot: what the live slot is before anyone has signed in.
 *
 * <p>It exists because the device id and the token keys are both needed *before* the account is
 * known - the login grant carries the first and the login request itself needs the second. Defined
 * here, in the leaf module, so `AccountRegistryService` can mirror the live slot without the two
 * files importing each other.</p>
 */
export const BOOTSTRAP_SLOT_ID = '@bootstrap';

/** Where the live slot id is kept for the synchronous readers that need it before Angular boots. */
export const ACTIVE_SLOT_KEY = 'alpine_active_account';

/** The keys `angular-oauth2-oidc` writes, and the ones a migration has to move. */
const OAUTH_KEYS = [
    'access_token',
    'refresh_token',
    'expires_at',
    'access_token_stored_at',
    'id_token',
    'id_token_claims_obj',
    'id_token_expires_at',
    'id_token_stored_at',
    'nonce',
    'PKCE_verifier',
    'session_state',
    'granted_scopes',
] as const;

/**
 * The token store, namespaced by account slot.
 *
 * <p><b>This is the whole of multi-account session handling.</b> `angular-oauth2-oidc` writes to
 * fixed keys in whatever `OAuthStorage` it is given, and the app gave it `localStorage` directly -
 * so a second account's tokens would overwrite the first's, and signing in anywhere meant signing
 * out everywhere. Prefixing the keys per slot means every background account's refresh token simply
 * persists, untouched, with no change anywhere in `AuthService`.</p>
 *
 * <p>Reads the live slot from `localStorage` rather than from {@link AccountRegistryService},
 * deliberately. `OAuthStorage` is constructed during application bootstrap and its methods are
 * synchronous, while the registry lives behind an async store read - so injecting it here would
 * either deadlock the provider graph or answer with the wrong slot on the first read, which is the
 * one that decides whether the app thinks anyone is signed in.</p>
 */
export class ScopedOAuthStorage implements OAuthStorage {
    getItem(key: string): string | null {
        return localStorage.getItem(this.scoped(key));
    }

    removeItem(key: string): void {
        localStorage.removeItem(this.scoped(key));
    }

    setItem(key: string, data: string): void {
        localStorage.setItem(this.scoped(key), data);
    }

    private scoped(key: string): string {
        return scopedOAuthKey(activeSlotId(), key);
    }
}

export function scopedOAuthKey(slotId: string, key: string): string {
    return `${slotId}::${key}`;
}

/**
 * The live slot, as the synchronous readers see it.
 *
 * <p>Both of these are a *mirror* of the registry file, which is the source of truth, so both fail
 * soft. Storage that will not answer - a locked-down browser profile, a quota error, a test runner
 * whose global has no methods - degrades to the bootstrap slot, which routes to the login screen.
 * That is recoverable; taking down the account registry with it is not, and the registry writes
 * this on every publish.</p>
 */
export function activeSlotId(): string {
    try {
        return localStorage.getItem(ACTIVE_SLOT_KEY) ?? BOOTSTRAP_SLOT_ID;
    } catch {
        return BOOTSTRAP_SLOT_ID;
    }
}

export function setActiveSlotId(slotId: string): void {
    try {
        localStorage.setItem(ACTIVE_SLOT_KEY, slotId);
    } catch {
        // See above. The registry file still records which slot is live; only the next cold boot's
        // synchronous read is lost, and that reads as "nobody is signed in yet".
    }
}

/**
 * Moves the pre-slot tokens under the slot that inherits them.
 *
 * <p><b>Run before anything reads a token.</b> Every existing installation has unprefixed keys, and
 * a build that only ever looks at prefixed ones would find none - which presents as every user
 * being signed out by an update. Nothing else about this change is user-visible if it goes wrong;
 * this is.</p>
 *
 * <p>Refuses to overwrite. A slot that already has tokens has them because it signed in, and a
 * leftover unprefixed key from before the upgrade must not replace a live session.</p>
 *
 * @returns true when something was moved.
 */
export function migrateLegacyOAuthKeys(slotId: string): boolean {
    let moved = false;

    for (const key of OAUTH_KEYS) {
        const legacy = localStorage.getItem(key);
        if (legacy === null) continue;

        const scoped = scopedOAuthKey(slotId, key);
        if (localStorage.getItem(scoped) === null) {
            localStorage.setItem(scoped, legacy);
            moved = true;
        }
        // Removed either way: leaving it behind means the next upgrade path sees it again and, if
        // the slot has since signed out, hands a stale token to whoever claims that slot next.
        localStorage.removeItem(key);
    }

    return moved;
}

/**
 * Hands the tokens a sign-in produced to the slot that sign-in turned out to be.
 *
 * <p><b>Every login writes its tokens to the bootstrap slot</b>, because the account is not known
 * until after the grant succeeds and the profile is read - and the slot is keyed on the account.
 * Without this the freshly-created slot would look at its own empty keys and the session would
 * break the instant it was established, on every first sign-in and every added account.</p>
 *
 * <p>A move, not a copy: tokens left under the bootstrap slot are a live session nobody owns, and
 * the next sign-in would find them there and adopt them into the wrong account.</p>
 *
 * @returns true when something was moved.
 */
export function adoptBootstrapTokens(toSlotId: string): boolean {
    if (toSlotId === BOOTSTRAP_SLOT_ID) return false;

    let moved = false;
    for (const key of OAUTH_KEYS) {
        const from = scopedOAuthKey(BOOTSTRAP_SLOT_ID, key);
        const value = localStorage.getItem(from);
        if (value === null) continue;

        localStorage.setItem(scopedOAuthKey(toSlotId, key), value);
        localStorage.removeItem(from);
        moved = true;
    }
    return moved;
}

/** Drops one slot's tokens, and only that slot's. */
export function clearScopedOAuthKeys(slotId: string): void {
    for (const key of OAUTH_KEYS) {
        localStorage.removeItem(scopedOAuthKey(slotId, key));
    }
}
