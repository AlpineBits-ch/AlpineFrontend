import {inject, Injectable} from '@angular/core';

import {SecureStore} from '../../platform/ports/secure-store.port';
import {DeviceIdentityService} from '../device-identity.service';

/** Separates the IV from the ciphertext. Neither half contains it: both are base64. */
const SEPARATOR = '.';

/**
 * Seals cache entries under the key the MLS engine state already uses.
 *
 * <p><b>This service reads the key and never writes it.</b> `MlsService.localStateKey` mints one
 * when there is none, through `SecureStore.update`, and that is correct there: without a key the
 * engine cannot run at all. Here it would be a defect. `SecureStore` collapses every read failure
 * to `null`, so a keychain that is merely locked is indistinguishable from a device that has none,
 * and minting on that answer would seal every later cache entry under a key the real one will
 * never match - silently orphaning the cache, permanently, from one transient fault.</p>
 *
 * <p>So an absent key means the cache is unavailable, which degrades to exactly the behaviour that
 * shipped before it existed: an empty cache and a cold start. Nothing worse, and nothing to
 * recover from.</p>
 */
@Injectable({providedIn: 'root'})
export class CacheSealService {
    private readonly secureStore = inject(SecureStore);
    private readonly deviceIdentity = inject(DeviceIdentityService);

    /**
     * One resolved key per device id. See {@link cryptoKey} for both halves of that sentence.
     */
    private readonly keys = new Map<string, Promise<CryptoKey | null>>();

    async available(): Promise<boolean> {
        return (await this.cryptoKey()) !== null;
    }

    async seal(value: unknown): Promise<string | null> {
        const key = await this.cryptoKey();
        if (!key) return null;

        const iv = crypto.getRandomValues(new Uint8Array(12));
        const plaintext = new TextEncoder().encode(JSON.stringify(value));
        const ct = await crypto.subtle.encrypt({name: 'AES-GCM', iv}, key, plaintext);

        return `${toB64(iv)}${SEPARATOR}${toB64(new Uint8Array(ct))}`;
    }

    async unseal<T>(sealed: string): Promise<T | null> {
        const key = await this.cryptoKey();
        if (!key) return null;

        const [ivB64, ctB64] = sealed.split(SEPARATOR);
        if (!ivB64 || !ctB64) return null;

        try {
            const plaintext = await crypto.subtle.decrypt(
                {name: 'AES-GCM', iv: fromB64(ivB64)},
                key,
                fromB64(ctB64),
            );
            return JSON.parse(new TextDecoder().decode(plaintext)) as T;
        } catch {
            // A cache entry that will not open is a miss, not an error. It can be re-fetched.
            return null;
        }
    }

    /**
     * The imported AES key for whichever account is signed in <i>now</i>.
     *
     * <p><b>Keyed by device id, not held in one field.</b> Signing out is an in-document
     * `router.navigate` - no injector is destroyed - so this service outlives the account it first
     * read a key for. A single memoised key would seal the next account's cache entries under the
     * previous account's key, which is the same defect as writing them under its device id.</p>
     *
     * <p><b>Neither a rejection nor an absent key is memoised.</b> A rejection is a keychain that
     * was locked or still starting, and lifts by itself. A `null` is subtler and was the live bug:
     * `alpine_mls_{deviceId}_statekey` is minted by `MlsService.initStorage`, and hydration now runs
     * before it, so the first read of a first-ever launch legitimately answers "absent". Caching
     * that would mean the whole session persists nothing. Only a key that was actually there is
     * kept - the same rule as `MlsService.cacheKey`.</p>
     */
    private async cryptoKey(): Promise<CryptoKey | null> {
        const deviceId = await this.deviceIdentity.deviceId();

        let pending = this.keys.get(deviceId);
        if (pending === undefined) {
            // Shared while in flight, so two concurrent seals do not both read the keychain.
            pending = this.readKey(deviceId).catch(() => null);
            this.keys.set(deviceId, pending);
        }

        const key = await pending;
        // Dropped rather than kept, so the next call re-reads. Guarded on identity so a concurrent
        // call that already installed a *newer* attempt is not evicted by this one's answer.
        if (key === null && this.keys.get(deviceId) === pending) this.keys.delete(deviceId);
        return key;
    }

    private async readKey(deviceId: string): Promise<CryptoKey | null> {
        // getItem, deliberately. See the class comment: update() would mint.
        const raw = await this.secureStore.getItem(`alpine_mls_${deviceId}_statekey`);
        if (!raw) return null;

        return crypto.subtle.importKey('raw', fromB64(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
    }
}

function toB64(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes));
}

// Built through `new ArrayBuffer` rather than `Uint8Array.from`, deliberately: the latter types as
// `Uint8Array<ArrayBufferLike>`, which the DOM crypto types (`BufferSource`) reject because
// `ArrayBufferLike` admits `SharedArrayBuffer`. Same construction `MlsService`'s `fromB64` uses.
function fromB64(value: string): ArrayBuffer {
    const binary = atob(value);
    const out = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out.buffer;
}
