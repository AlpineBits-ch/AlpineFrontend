/**
 * What a clicked notification has to carry back into the app. `actionTypeId` names the button or
 * body the user hit; `extra` is the routing payload `main-page.component.ts` navigates on.
 */
export interface NotificationTagPayload {
    actionTypeId: string;
    extra: Record<string, string>;
}

/** What an activation with nothing usable attached counts as. */
const DEFAULT_ACTION_TYPE_ID = 'message';

/**
 * Packs an activation payload into the `Notifier` port's single `tag` string, as JSON.
 *
 * On web the tag doubles as the Notification API's coalescing key, so adding anything unique per
 * notification (a timestamp, a message id) silently turns coalescing off.
 */
export function encodeNotificationTag(payload: NotificationTagPayload): string {
    return JSON.stringify({actionTypeId: payload.actionTypeId, extra: payload.extra});
}

/**
 * Reads a tag back, tolerating anything that is not one. Must never throw: a tag can arrive from
 * outside this codec. An unparseable non-empty tag is read as a bare `actionTypeId`.
 */
export function decodeNotificationTag(tag: string | undefined | null): NotificationTagPayload {
    if (!tag) return {actionTypeId: DEFAULT_ACTION_TYPE_ID, extra: {}};

    let parsed: unknown;
    try {
        parsed = JSON.parse(tag);
    } catch {
        return {actionTypeId: tag, extra: {}};
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {actionTypeId: tag, extra: {}};
    }

    const record = parsed as {actionTypeId?: unknown; extra?: unknown};
    return {
        actionTypeId: typeof record.actionTypeId === 'string' && record.actionTypeId
            ? record.actionTypeId
            : DEFAULT_ACTION_TYPE_ID,
        extra: stringValues(record.extra),
    };
}

/**
 * Coerces a host-supplied payload to the `Record<string, string>` the routing code reads. Scalars
 * are stringified; nested objects are dropped rather than becoming `"[object Object]"`.
 */
function stringValues(value: unknown): Record<string, string> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};

    const out: Record<string, string> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        if (typeof raw === 'string') out[key] = raw;
        else if (typeof raw === 'number' || typeof raw === 'boolean') out[key] = String(raw);
    }
    return out;
}
