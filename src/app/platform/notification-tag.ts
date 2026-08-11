/**
 * What a clicked notification has to carry back into the app.
 *
 * <p>`actionTypeId` names the button (or the body) the user hit; `extra` is the routing payload -
 * `main-page.component.ts` reads `conversationId` and `type` out of it to decide where to navigate.
 * Both existed before the port layer and both are load-bearing.</p>
 */
export interface NotificationTagPayload {
    actionTypeId: string;
    extra: Record<string, string>;
}

/**
 * What an activation with nothing usable attached counts as.
 *
 * <p>Same literal the notification path has always defaulted to, in both directions: a notification
 * sent without an `actionTypeId` was sent as `message`, and one that came back without one was read
 * as `message`.</p>
 */
const DEFAULT_ACTION_TYPE_ID = 'message';

/**
 * Packs an activation payload into the `Notifier` port's single `tag` string.
 *
 * <p><b>Why a codec instead of two more fields on the port.</b> `Notifier.notify` takes a `tag` and
 * `Notifier.onActivated` hands one back, because that is the only thing both hosts can carry through -
 * a desktop action type and a Web Push `notificationclick` have nothing else in common. But the app
 * has always routed clicks on `extra`, so the tag has to be a container rather than a label. JSON,
 * not a delimited string, because `extra` values come from message content and any separator this
 * picked would eventually appear inside one.</p>
 *
 * <p>On web the tag doubles as the Notification API's coalescing key, so what goes in here decides
 * what replaces what: two DMs in the same conversation carry the same `conversationId` and so collapse
 * to one toast, while a DM and a mention do not. That is the behaviour we want, and it is a
 * consequence of this encoding rather than of anything the caller asked for - worth knowing before
 * adding a timestamp or a message id in here, which would silently turn coalescing off.</p>
 */
export function encodeNotificationTag(payload: NotificationTagPayload): string {
    return JSON.stringify({actionTypeId: payload.actionTypeId, extra: payload.extra});
}

/**
 * Reads a tag back, tolerating anything that is not one.
 *
 * <p>Never throws. A tag can arrive from outside this codec - a notification posted by an earlier
 * version of the app and clicked after an update, or a service worker replaying one - and an
 * activation that throws while decoding would take the click handler down instead of merely
 * mis-routing it. An unparseable non-empty tag is read as a bare `actionTypeId`, which is what a
 * plain string tag most plausibly meant.</p>
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
 * Coerces a host-supplied payload to the `Record<string, string>` the routing code reads.
 *
 * <p>The Tauri plugin types `extra` as `Record<string, unknown>` and a WinRT toast round-trips it
 * through Rust, so a number can come back where a string went in. Values are stringified rather than
 * dropped, and nested objects are dropped rather than stringified into `"[object Object]"`.</p>
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
