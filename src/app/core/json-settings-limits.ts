/**
 * Limits on the client-owned settings blob (T0-6).
 *
 * <p>`GET`/`PUT /users/self/settings` stores an arbitrary JSON document forever. It is
 * <b>client-owned UI state with no server semantics</b>: nothing in it is enforced, nothing in it
 * is read by any policy decision, and nothing privacy-relevant may live there. Anything that has
 * to be honoured belongs in the privacy record, which has a schema and an audit trail.</p>
 *
 * <p>The server is the real enforcement point - these checks exist so the app finds out at the
 * point of the mistake rather than by way of a rejected save it cannot explain.</p>
 */

/** Matches the server's cap. A blob at this size is already far past "UI preferences". */
export const JSON_SETTINGS_MAX_BYTES = 16 * 1024;

/** Deep enough for any real preference tree, shallow enough to bound the recursion. */
export const JSON_SETTINGS_MAX_DEPTH = 16;

export type JsonSettingsRejection = 'not-an-object' | 'too-large' | 'too-deep' | 'not-serializable';

export interface JsonSettingsCheck {
    ok: boolean;
    reason?: JsonSettingsRejection;
    bytes?: number;
}

function depthOf(value: unknown, depth = 0): number {
    if (depth > JSON_SETTINGS_MAX_DEPTH || value === null || typeof value !== 'object') return depth;

    let deepest = depth;
    for (const entry of Object.values(value as Record<string, unknown>)) {
        const found = depthOf(entry, depth + 1);
        if (found > deepest) deepest = found;
        if (deepest > JSON_SETTINGS_MAX_DEPTH) return deepest;
    }
    return deepest;
}

/**
 * Checks a candidate settings document against the server's limits.
 *
 * <p>Size is measured in UTF-8 bytes, not string length - the cap the server applies is on the
 * encoded payload, and a document of emoji or non-Latin text is a good deal larger than its
 * `.length` suggests.</p>
 */
export function checkJsonSettings(settings: unknown): JsonSettingsCheck {
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
        return {ok: false, reason: 'not-an-object'};
    }

    let serialized: string;
    try {
        serialized = JSON.stringify(settings);
    } catch {
        // Cyclic structures, BigInt, and anything with a throwing toJSON.
        return {ok: false, reason: 'not-serializable'};
    }
    if (serialized === undefined) return {ok: false, reason: 'not-serializable'};

    const bytes = new TextEncoder().encode(serialized).length;
    if (bytes > JSON_SETTINGS_MAX_BYTES) return {ok: false, reason: 'too-large', bytes};
    if (depthOf(settings) > JSON_SETTINGS_MAX_DEPTH) return {ok: false, reason: 'too-deep', bytes};

    return {ok: true, bytes};
}
