import {afterEach, describe, expect, it, vi} from 'vitest';
import {CallFocusService} from './call-focus.service';

function setup(): CallFocusService {
    return new CallFocusService();
}

describe('CallFocusService', () => {
    // Only two tests below touch fake timers, but restoring unconditionally after every test is
    // cheap insurance against a failed assertion leaving them on for whichever test runs next.
    afterEach(() => vi.useRealTimers());

    it('returns the request to the matching scope, once', () => {
        const focus = setup();

        focus.request('call:c1', {userId: 'user-a'});

        expect(focus.consume('call:c1')).toEqual({shareId: undefined, userId: 'user-a'});
        // One-shot: a second consume for the same scope finds nothing left to hand back.
        expect(focus.consume('call:c1')).toBeNull();
    });

    it('will not hand a request to a scope that did not ask for it', () => {
        const focus = setup();

        focus.request('call:c1', {shareId: 'share-a'});

        // Wrong scope: not this caller's to consume, and left in place for the right one.
        expect(focus.consume('call:other')).toBeNull();
        expect(focus.consume('call:c1')).toEqual({shareId: 'share-a', userId: undefined});
    });

    it('drops a request that nobody consumed before its TTL', () => {
        vi.useFakeTimers();
        const focus = setup();

        focus.request('call:c1', {userId: 'user-a'});
        vi.advanceTimersByTime(30_001);

        // Consuming late must behave exactly like never having requested at all - a request armed
        // before the user joins voice (Task 3's click-to-watch) must not ambush them by firing on an
        // unrelated join minutes or hours later.
        expect(focus.consume('call:c1')).toBeNull();
    });

    it('still honours a request consumed just under the TTL', () => {
        vi.useFakeTimers();
        const focus = setup();

        focus.request('call:c1', {userId: 'user-a'});
        vi.advanceTimersByTime(29_999);

        expect(focus.consume('call:c1')).toEqual({shareId: undefined, userId: 'user-a'});
    });

    it('replaces a pending request rather than queuing a second one', () => {
        const focus = setup();

        focus.request('call:c1', {userId: 'user-a'});
        focus.request('call:c2', {userId: 'user-b'});

        // The first scope's request is gone, not merely second in line.
        expect(focus.consume('call:c1')).toBeNull();
        expect(focus.consume('call:c2')).toEqual({shareId: undefined, userId: 'user-b'});
    });
});
