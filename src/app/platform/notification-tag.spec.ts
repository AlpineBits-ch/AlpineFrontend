/**
 * The tag codec: the `Notifier` port carries one string through an activation, and the app routes on
 * an `{actionTypeId, extra}` pair, so this is what makes those the same thing.
 *
 * <p>The load-bearing property is that decoding **never throws**. A tag can arrive from outside this
 * codec - posted by an earlier version of the app and clicked after an update - and a throw on that
 * path takes the click handler down rather than merely mis-routing one click.</p>
 */
import {decodeNotificationTag, encodeNotificationTag} from './notification-tag';

it('round-trips the routing payload', () => {
    const tag = encodeNotificationTag({
        actionTypeId: 'household',
        extra: {type: 'household', choreId: 'c-1'},
    });

    expect(decodeNotificationTag(tag)).toEqual({
        actionTypeId: 'household',
        extra: {type: 'household', choreId: 'c-1'},
    });
});

it('gives the same tag for the same payload, so notifications coalesce', () => {
    // On web the tag is the Notification API's coalescing key: two messages in one conversation
    // collapse to one toast because this is stable, not because anything asked for it.
    const a = encodeNotificationTag({actionTypeId: 'message', extra: {conversationId: 'conv-1'}});
    const b = encodeNotificationTag({actionTypeId: 'message', extra: {conversationId: 'conv-1'}});

    expect(a).toBe(b);
});

it('reads a missing tag as a plain message activation', () => {
    expect(decodeNotificationTag(undefined)).toEqual({actionTypeId: 'message', extra: {}});
    expect(decodeNotificationTag('')).toEqual({actionTypeId: 'message', extra: {}});
});

it('reads a tag that is not JSON as a bare action type', () => {
    expect(decodeNotificationTag('call-ring')).toEqual({actionTypeId: 'call-ring', extra: {}});
});

it('survives JSON that is the wrong shape', () => {
    expect(decodeNotificationTag('[1,2,3]').extra).toEqual({});
    expect(decodeNotificationTag('"just a string"').actionTypeId).toBe('"just a string"');
    expect(decodeNotificationTag('{"extra":42}')).toEqual({actionTypeId: 'message', extra: {}});
});

it('stringifies values a host round-tripped as numbers', () => {
    // WinRT toasts carry `extra` through Rust, so a number can come back where a string went in, and
    // the routing code reads strings.
    expect(
        decodeNotificationTag('{"actionTypeId":"message","extra":{"unread":3,"muted":false}}').extra,
    ).toEqual({unread: '3', muted: 'false'});
});

it('drops nested values rather than stringifying them into [object Object]', () => {
    expect(decodeNotificationTag('{"extra":{"ok":"yes","nested":{"a":1}}}').extra).toEqual({ok: 'yes'});
});
