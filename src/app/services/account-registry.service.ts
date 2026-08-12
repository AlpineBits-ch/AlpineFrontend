import {inject, Injectable, signal} from '@angular/core';
import {SettingsStore, SettingsStoreFactory} from '../platform/ports/settings-store.port';
import {
    activeSlotId as liveSlotId,
    BOOTSTRAP_SLOT_ID,
    setActiveSlotId,
} from './scoped-oauth-storage';
import {SETTINGS_FILE} from './settings-store';

// Re-exported from where it is defined, so the many callers that reach for it alongside the slot
// list keep one import and the two modules keep a one-way dependency.
export {BOOTSTRAP_SLOT_ID};

const REGISTRY_KEY = 'accounts';

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

/**
 * The persisted half: the slot list, and nothing about which one is live.
 *
 * <p><b>Which slot is live is deliberately not in here.</b> It used to be, alongside the
 * `localStorage` mirror that the synchronous readers need - and two sources of truth for one fact
 * is exactly as safe as it sounds. Reading the file republished its `activeSlotId` over the mirror,
 * so "Add Account" - which sets the mirror aside and leaves the file alone on purpose - was undone
 * by the first thing on the login screen that asked for a device id. The mirror came back, the
 * OAuth storage found the previous account's tokens again, and the login screen redirected straight
 * back into it. The feature reloaded the page and did nothing else.</p>
 *
 * <p>{@link activeSlotId} is now the only answer, and it comes from the mirror. Losing the mirror
 * costs nothing that is not already lost: the tokens live beside it.</p>
 */
interface RegistryFile {
    slots: AccountSlot[];
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
    /**
     * The settings backend, injected rather than chosen.
     *
     * <p>This service is reached early - a route guard and the device-id interceptor both get here
     * before most of the app exists - which is why it used to call a free `openSettingsStore()` that
     * asked `detectHost()` itself. A field injection is safe at that point regardless: the provider
     * is on the environment injector from `providePlatform()`, and neither adapter does any work
     * while being constructed. What it buys is that "which host is this" is no longer a question
     * this file can answer, so a spec supplies a store instead of defining a global.</p>
     */
    private readonly settings = inject(SettingsStoreFactory);

    private readonly _slots = signal<AccountSlot[]>([]);
    private readonly _activeSlotId = signal<string | null>(null);

    readonly slots = this._slots.asReadonly();
    /** Synchronous view for consumers already past the first load - the switcher UI, in practice. */
    readonly activeSlotIdSnapshot = this._activeSlotId.asReadonly();

    /** Loaded once; every later read is served from the signals. */
    private loaded: Promise<RegistryFile> | null = null;

    /** The live slot, or null when none is - before sign-in, and while adding an account. */
    async activeSlot(): Promise<AccountSlot | null> {
        const file = await this.load();
        const id = liveSlotId();
        return file.slots.find(s => s.id === id) ?? null;
    }

    /**
     * The live slot's id, or {@link BOOTSTRAP_SLOT_ID}.
     *
     * <p>Read from the mirror, which is the only record of it - see {@link RegistryFile}. Never
     * null, so callers cannot forget the pre-login case and end up with an undefined segment in a
     * store filename.</p>
     *
     * <p>Still async, and still awaits the file: callers use the answer to name per-account stores,
     * and handing them an id for a slot this service has not loaded yet invites a read against a
     * registry that turns out to be empty.</p>
     */
    async activeSlotId(): Promise<string> {
        await this.load();
        return liveSlotId();
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
                // Committed as part of the write, never as a side effect of a read - that is the
                // distinction "Add Account" depends on.
                live: slot.id,
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
                live: slotId,
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
                live: liveSlotId() === slotId
                    // The most recently used survivor, so removing one of several accounts lands
                    // somewhere useful rather than on the login screen.
                    ? slots.slice().sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0]?.id
                        ?? BOOTSTRAP_SLOT_ID
                    : liveSlotId(),
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

    /**
     * Loads the slot list.
     *
     * <p><b>Writes nothing.</b> Not the file, and above all not the live-slot mirror - republishing
     * it from here is the bug that made "Add Account" a no-op. A read must be able to happen at any
     * moment, from any caller, without changing who the app thinks is signed in.</p>
     *
     * <p>This is the first store read the app performs at all - `DeviceIdentityService.deviceId()`
     * goes through {@link activeSlotId}, which awaits this - so it is also the first thing that
     * breaks when there is no IPC host. See {@link SettingsStoreFactory}.</p>
     */
    private async read(): Promise<RegistryFile> {
        const store = this.store();
        const raw = await store.get<{slots?: AccountSlot[]}>(REGISTRY_KEY);
        const file: RegistryFile = {
            slots: Array.isArray(raw?.slots) ? raw.slots : [],
        };
        this.publish(file);
        return file;
    }

    /** Read, transform, write, publish - the only path that changes anything. */
    private async mutate<T>(
        change: (file: RegistryFile) => RegistryFile & {live?: string; result: T},
    ): Promise<T> {
        const current = await this.load();
        const {result, live, ...next} = change(current);

        const store = this.store();
        await store.set(REGISTRY_KEY, next);
        await store.save();

        // The mirror moves only here, and only when the change asked for it.
        if (live !== undefined) setActiveSlotId(live);

        this.loaded = Promise.resolve(next);
        this.publish(next);
        return result;
    }

    /**
     * A handle on the settings file, opened per use.
     *
     * <p>Per call rather than held, because that is what the readers already did: a
     * `new LazyStore(...)` at every read and every write. `LazyStore` is lazy by construction, so an
     * unused one costs nothing, and keeping the lifetime identical is what made moving off the free
     * function invisible to the desktop path.</p>
     */
    private store(): SettingsStore {
        return this.settings.open(SETTINGS_FILE);
    }

    /** Refreshes the synchronous views. Never writes anything - see {@link read}. */
    private publish(file: RegistryFile): void {
        this._slots.set(file.slots);
        this._activeSlotId.set(liveSlotId());
    }
}
