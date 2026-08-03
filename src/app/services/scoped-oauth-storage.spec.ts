/**
 * Tokens, namespaced by account slot.
 *
 * <p>This is the whole of multi-account session handling. `angular-oauth2-oidc` writes to fixed key
 * names in whatever `OAuthStorage` it is handed, and the app handed it `localStorage` directly - so
 * a second account's tokens overwrote the first's and signing in anywhere meant signing out
 * everywhere.</p>
 *
 * <p>The migration is the part that can hurt an existing user. Every installation upgrading has
 * unprefixed keys, and a build that only ever looks at prefixed ones finds none - which presents as
 * the update signing everybody out.</p>
 */
import {
    ACTIVE_SLOT_KEY,
    activeSlotId,
    BOOTSTRAP_SLOT_ID,
    clearScopedOAuthKeys,
    migrateLegacyOAuthKeys,
    ScopedOAuthStorage,
    scopedOAuthKey,
    setActiveSlotId,
} from './scoped-oauth-storage';

let storage: ScopedOAuthStorage;

/**
 * This runner's global `localStorage` exists but has no methods on it, so every read and write here
 * would silently do nothing and the isolation these tests exist to prove would be unobservable.
 * An in-memory stand-in makes it real.
 */
const store = new Map<string, string>();

beforeAll(() => {
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, String(v)),
            removeItem: (k: string) => void store.delete(k),
            clear: () => store.clear(),
        },
    });
});

beforeEach(() => {
    store.clear();
    storage = new ScopedOAuthStorage();
});

afterEach(() => store.clear());

describe('the live slot', () => {
    it('is the bootstrap slot before anyone has signed in', () => {
        expect(activeSlotId()).toBe(BOOTSTRAP_SLOT_ID);
    });

    it('is whatever was last committed', () => {
        setActiveSlotId('slot-a');
        expect(activeSlotId()).toBe('slot-a');
        expect(localStorage.getItem(ACTIVE_SLOT_KEY)).toBe('slot-a');
    });
});

describe('isolation between slots', () => {
    it('keeps one slot tokens invisible to another', () => {
        setActiveSlotId('slot-a');
        storage.setItem('access_token', 'token-a');

        setActiveSlotId('slot-b');

        expect(storage.getItem('access_token')).toBeNull();
    });

    it('leaves a background slot tokens intact - this is what keeps it signed in', () => {
        setActiveSlotId('slot-a');
        storage.setItem('refresh_token', 'refresh-a');

        setActiveSlotId('slot-b');
        storage.setItem('refresh_token', 'refresh-b');

        setActiveSlotId('slot-a');
        expect(storage.getItem('refresh_token')).toBe('refresh-a');
    });

    it('removes from the live slot only', () => {
        setActiveSlotId('slot-a');
        storage.setItem('access_token', 'token-a');
        setActiveSlotId('slot-b');
        storage.setItem('access_token', 'token-b');

        storage.removeItem('access_token');

        expect(storage.getItem('access_token')).toBeNull();
        setActiveSlotId('slot-a');
        expect(storage.getItem('access_token')).toBe('token-a');
    });

    it('writes under a key that names the slot', () => {
        setActiveSlotId('slot-a');
        storage.setItem('access_token', 'token-a');

        expect(localStorage.getItem(scopedOAuthKey('slot-a', 'access_token'))).toBe('token-a');
        // The unprefixed key is what the previous build used. Writing it as well would let one
        // account's token be read as another's by anything that had not been updated.
        expect(localStorage.getItem('access_token')).toBeNull();
    });
});

describe('migrating an installation that predates slots', () => {
    it('adopts the existing tokens rather than orphaning them', () => {
        localStorage.setItem('access_token', 'legacy-access');
        localStorage.setItem('refresh_token', 'legacy-refresh');
        localStorage.setItem('expires_at', '123');

        expect(migrateLegacyOAuthKeys('slot-a')).toBe(true);

        setActiveSlotId('slot-a');
        expect(storage.getItem('access_token')).toBe('legacy-access');
        expect(storage.getItem('refresh_token')).toBe('legacy-refresh');
        expect(storage.getItem('expires_at')).toBe('123');
    });

    it('clears the unprefixed keys once they have been adopted', () => {
        localStorage.setItem('access_token', 'legacy-access');

        migrateLegacyOAuthKeys('slot-a');

        // Left behind, the next upgrade path sees them again and - if that slot has since signed
        // out - hands a stale token to whoever claims the slot next.
        expect(localStorage.getItem('access_token')).toBeNull();
    });

    it('never replaces a live session with a leftover', () => {
        setActiveSlotId('slot-a');
        storage.setItem('access_token', 'current');
        localStorage.setItem('access_token', 'stale-leftover');

        migrateLegacyOAuthKeys('slot-a');

        expect(storage.getItem('access_token')).toBe('current');
        expect(localStorage.getItem('access_token')).toBeNull();
    });

    it('reports that it did nothing on a fresh install', () => {
        expect(migrateLegacyOAuthKeys('slot-a')).toBe(false);
    });

    it('is idempotent', () => {
        localStorage.setItem('refresh_token', 'legacy-refresh');

        migrateLegacyOAuthKeys('slot-a');
        migrateLegacyOAuthKeys('slot-a');

        setActiveSlotId('slot-a');
        expect(storage.getItem('refresh_token')).toBe('legacy-refresh');
    });
});

describe('clearing one slot', () => {
    it('removes exactly that slot keys', () => {
        setActiveSlotId('slot-a');
        storage.setItem('access_token', 'token-a');
        storage.setItem('refresh_token', 'refresh-a');
        setActiveSlotId('slot-b');
        storage.setItem('access_token', 'token-b');

        clearScopedOAuthKeys('slot-a');

        expect(storage.getItem('access_token')).toBe('token-b');
        setActiveSlotId('slot-a');
        expect(storage.getItem('access_token')).toBeNull();
        expect(storage.getItem('refresh_token')).toBeNull();
    });

    it('leaves the live slot marker alone, so the caller decides where to go next', () => {
        setActiveSlotId('slot-a');

        clearScopedOAuthKeys('slot-b');

        expect(activeSlotId()).toBe('slot-a');
    });
});
