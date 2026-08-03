import {Injectable, signal} from '@angular/core';
import {LazyStore} from '@tauri-apps/plugin-store';

const STORE_FILE = 'settings.json';
const REGISTRY_KEY = 'accounts';

/**
 * The bootstrap slot: what {@link AccountRegistryService.activeSlotId} answers before anyone has
 * signed in.
 *
 * <p>It exists because the device id is needed *before* the account is known - the login grant
 * carries it, and so does every request the login screen makes. Without a slot to hang it on there
 * would be no id at all on that path, and `AuthService.login` would stop linking sessions to
 * devices on a fresh install.</p>
 */
export const BOOTSTRAP_SLOT_ID = '@bootstrap';

/** One signed-in account on this machine. */
export interface AccountSlot {
    /**
     * Stable, opaque, and **not** the user id.
     *
     * <p>It namespaces the device id, and later the OAuth token keys. A user id would work until
     * the same account was added from two servers, and a `{server}:{user}` composite would change
     * if either half were ever renamed - at which point every local store keyed on it silently
     * becomes a different account's.</p>
     */
    id: string;
    userId: string;
    /** Slots are per-server by construction, which is what makes federation fall out for free. */
    serverUrl: string;
    username: string;
    displayName: string;
    avatarUrl: string | null;
    lastUsedAt: number;
}

interface RegistryFile {
    slots: AccountSlot[];
    activeSlotId: string | null;
}

/**
 * What identifies an account well enough to find or create its slot.
 *
 * <p>Only the pair that does the matching is required. The display fields come from the profile,
 * which is a second request - making a slot wait for it would put the account's device id, and so
 * every store name derived from it, behind a call that can fail.</p>
 */
export interface AccountIdentity {
    userId: string;
    serverUrl: string;
    username?: string;
    displayName?: string;
    avatarUrl?: string | null;
}

/** The display half, filled in once the profile arrives. */
export interface AccountProfilePatch {
    username?: string;
    displayName?: string;
    avatarUrl?: string | null;
}

/**
 * Which accounts this installation holds, and which one is live.
 *
 * <p><b>Read once and held in memory.</b> {@link activeSlotId} is on the hot path - the device-id
 * interceptor asks for it on every request - and a `LazyStore` read is IPC. The file is the source
 * of truth, the signal is the cache, and every write goes through {@link mutate} so the two cannot
 * drift.</p>
 *
 * <p>Exactly one slot is live at a time. Background accounts hold persisted tokens and nothing
 * else: no socket, no MLS engine, no notifications. Switching is a teardown and a re-entry rather
 * than a second live session, because every service that would need to be duplicated for a second
 * one - the websockets, the WebRTC peers, the Rust `MlsState` handle - is a singleton over process
 * state.</p>
 */
@Injectable({providedIn: 'root'})
export class AccountRegistryService {
    private readonly _slots = signal<AccountSlot[]>([]);
    private readonly _activeSlotId = signal<string | null>(null);

    readonly slots = this._slots.asReadonly();
    /** Synchronous view for consumers already past the first load - the switcher UI, in practice. */
    readonly activeSlotIdSnapshot = this._activeSlotId.asReadonly();

    /** Loaded once; every later read is served from the signals. */
    private loaded: Promise<RegistryFile> | null = null;

    /** The live slot, or null before anyone has signed in. */
    async activeSlot(): Promise<AccountSlot | null> {
        const file = await this.load();
        return file.slots.find(s => s.id === file.activeSlotId) ?? null;
    }

    /**
     * The live slot's id, or {@link BOOTSTRAP_SLOT_ID}.
     *
     * <p>Never null, so callers cannot forget the pre-login case and end up with an undefined
     * segment in a store filename.</p>
     */
    async activeSlotId(): Promise<string> {
        const file = await this.load();
        return file.activeSlotId ?? BOOTSTRAP_SLOT_ID;
    }

    async list(): Promise<AccountSlot[]> {
        return (await this.load()).slots;
    }

    /**
     * Finds the slot for an account and makes it live, creating it if this is the first sign-in.
     *
     * <p>Matched on `{serverUrl, userId}` rather than on the username: a rename must not strand the
     * account's device id, its MLS state or its message history behind a slot nothing looks up
     * any more.</p>
     */
    async ensureSlot(identity: AccountIdentity): Promise<AccountSlot> {
        return this.mutate(file => {
            const existing = file.slots.find(
                s => s.userId === identity.userId && s.serverUrl === identity.serverUrl,
            );

            const slot: AccountSlot = existing
                ? {
                    ...existing,
                    // Only overwritten when this sign-in actually carried a value: a slot that
                    // already knows the username must not be blanked by a call that did not.
                    username: identity.username ?? existing.username,
                    displayName: identity.displayName ?? existing.displayName,
                    avatarUrl: identity.avatarUrl ?? existing.avatarUrl,
                    lastUsedAt: Date.now(),
                }
                : {
                    id: crypto.randomUUID(),
                    userId: identity.userId,
                    serverUrl: identity.serverUrl,
                    username: identity.username ?? '',
                    displayName: identity.displayName ?? identity.username ?? '',
                    avatarUrl: identity.avatarUrl ?? null,
                    lastUsedAt: Date.now(),
                };

            return {
                slots: existing
                    ? file.slots.map(s => (s.id === slot.id ? slot : s))
                    : [...file.slots, slot],
                activeSlotId: slot.id,
                result: slot,
            };
        });
    }

    /**
     * Fills in the display half once the profile has arrived.
     *
     * <p>Separate from {@link ensureSlot} because the profile is a request that can fail, and the
     * switcher showing a blank name is a cosmetic problem where a slot that never got created is
     * an account with no device id.</p>
     */
    async updateProfile(slotId: string, patch: AccountProfilePatch): Promise<void> {
        await this.mutate(file => ({
            ...file,
            slots: file.slots.map(s => (s.id === slotId ? {
                ...s,
                username: patch.username ?? s.username,
                displayName: patch.displayName ?? patch.username ?? s.displayName,
                avatarUrl: patch.avatarUrl !== undefined ? patch.avatarUrl : s.avatarUrl,
            } : s)),
            result: undefined,
        }));
    }

    /** Makes an existing slot live. No-op for an unknown id, so a stale link cannot blank the session. */
    async activate(slotId: string): Promise<boolean> {
        return this.mutate(file => {
            const slot = file.slots.find(s => s.id === slotId);
            if (!slot) return {...file, result: false};
            return {
                slots: file.slots.map(s =>
                    s.id === slotId ? {...s, lastUsedAt: Date.now()} : s,
                ),
                activeSlotId: slotId,
                result: true,
            };
        });
    }

    /**
     * Drops a slot.
     *
     * <p>The caller is responsible for wiping that slot's key material first - this only forgets
     * where it lived. Removing the live slot leaves none live, which routes the app back to the
     * login screen.</p>
     */
    async remove(slotId: string): Promise<void> {
        await this.mutate(file => {
            const slots = file.slots.filter(s => s.id !== slotId);
            return {
                slots,
                activeSlotId: file.activeSlotId === slotId
                    // The most recently used survivor, so removing one of several accounts lands
                    // somewhere useful rather than on the login screen.
                    ? slots.slice().sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0]?.id ?? null
                    : file.activeSlotId,
                result: undefined,
            };
        });
    }

    private async load(): Promise<RegistryFile> {
        // A rejected promise left in the field would fail every later caller for the whole session,
        // turning one transient store error into a permanently account-less client.
        this.loaded ??= this.read().catch((err: unknown) => {
            this.loaded = null;
            throw err;
        });
        return this.loaded;
    }

    private async read(): Promise<RegistryFile> {
        const store = new LazyStore(STORE_FILE);
        const raw = await store.get<RegistryFile>(REGISTRY_KEY);
        const file: RegistryFile = {
            slots: Array.isArray(raw?.slots) ? raw.slots : [],
            activeSlotId: raw?.activeSlotId ?? null,
        };
        this.publish(file);
        return file;
    }

    /** Read, transform, write, publish - the only path that changes the file. */
    private async mutate<T>(
        change: (file: RegistryFile) => RegistryFile & {result: T},
    ): Promise<T> {
        const current = await this.load();
        const {result, ...next} = change(current);

        const store = new LazyStore(STORE_FILE);
        await store.set(REGISTRY_KEY, next);
        await store.save();

        this.loaded = Promise.resolve(next);
        this.publish(next);
        return result;
    }

    private publish(file: RegistryFile): void {
        this._slots.set(file.slots);
        this._activeSlotId.set(file.activeSlotId);
    }
}
