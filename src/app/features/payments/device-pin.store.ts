import {Injectable} from '@angular/core';
import {DevicePin, DevicePins} from './device-trust';

/**
 * Remembering which identity key each device had the last time we sealed to it.
 *
 * <p><b>Device-local by nature, and that is what makes it worth anything.</b> The pin is the only
 * check in this feature that does not depend on the server being honest: the directory could return
 * a different key for a housemate's device tomorrow and every server-supplied signal - the
 * certificate flag, the revocation timestamp - could agree that the new one is fine, because the
 * party serving them is the party that would be substituting. A record kept here, written the first
 * time and never rewritten without a person agreeing, is the thing that notices.</p>
 *
 * <p>Stored in `localStorage` rather than in the account settings blob, for the same reason the
 * theme and the language are: it has to be readable synchronously, it has to work in the browser
 * build where there is no Tauri keychain, and it describes what <i>this</i> installation has seen.
 * Syncing it to the server would also hand the server the ability to reset it, which is the one
 * thing a pin must not allow.</p>
 *
 * <p>Scoped per guild and per signed-in account. Two households can legitimately contain the same
 * person on the same device, and a shared machine can hold two accounts; neither should be able to
 * read or clobber the other's record of what it has seen.</p>
 */
@Injectable({providedIn: 'root'})
export class DevicePinStore {
    private static readonly PREFIX = 'alpine.payments.pins';

    /** What we last sealed to, for this account in this household. */
    read(ownUserId: string, guildId: string): DevicePins {
        try {
            const raw = localStorage.getItem(this.key(ownUserId, guildId));
            if (!raw) return {};

            const parsed = JSON.parse(raw) as unknown;
            if (!parsed || typeof parsed !== 'object') return {};

            // Filtered rather than trusted: a hand-edited or half-written entry should degrade to
            // "we have not seen this device", which prompts, rather than to a pin of `undefined`,
            // which would compare unequal to every real key and cry attack on all of them.
            const pins: Record<string, DevicePin> = {};
            for (const [deviceId, value] of Object.entries(parsed as Record<string, unknown>)) {
                const pin = readPin(value);
                if (pin) pins[deviceId] = pin;
            }
            return pins;
        } catch {
            // A quota error, a disabled store, a private window. Nothing is pinned, so every
            // device reads as first-seen and the user is asked. That is the safe direction.
            return {};
        }
    }

    /** Replaces the record. Callers pass the result of `pinsAfterSeal`, never a partial map. */
    write(ownUserId: string, guildId: string, pins: DevicePins): void {
        try {
            localStorage.setItem(this.key(ownUserId, guildId), JSON.stringify(pins));
        } catch {
            // Failing to persist costs a prompt next time, which is strictly better than failing
            // the seal the user has just confirmed.
        }
    }

    /** Forgets everything for one household - used when the account leaves it. */
    clear(ownUserId: string, guildId: string): void {
        try {
            localStorage.removeItem(this.key(ownUserId, guildId));
        } catch {
            // See `write`.
        }
    }

    private key(ownUserId: string, guildId: string): string {
        return `${DevicePinStore.PREFIX}.${ownUserId}.${guildId}`;
    }
}

/**
 * One stored entry, in either the current or the original shape.
 *
 * <p>The first version of this store held a bare base64 key per device. Pins gained the account
 * identity key version when the recipients endpoint started reporting one, and a migration that
 * dropped the old entries would have re-prompted about every device somebody had already vouched
 * for - which teaches people to click through the warning that matters most. A legacy string is
 * therefore read as a pin with no version, which is exactly what it is.</p>
 */
function readPin(value: unknown): DevicePin | null {
    if (typeof value === 'string') return value ? {publicKey: value} : null;

    if (!value || typeof value !== 'object') return null;
    const record = value as {publicKey?: unknown; identityKeyVersion?: unknown};
    if (typeof record.publicKey !== 'string' || !record.publicKey) return null;

    return {
        publicKey: record.publicKey,
        ...(typeof record.identityKeyVersion === 'number'
            ? {identityKeyVersion: record.identityKeyVersion}
            : {}),
    };
}
