import {Injectable} from '@angular/core';
import {DevicePin, DevicePins} from './device-trust';

/** Remembering which identity key each device had the last time we sealed to it. */
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

/** One stored entry, in either the current or the original shape. */
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
