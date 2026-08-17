/**
 * Which call stages are on screen, as the mini-player asks it.
 *
 * <p>The counting is the part worth a test. A boolean would be enough if registrations never
 * overlapped, but Angular creates an incoming view before destroying the outgoing one in some
 * structural swaps - switching conversations while a DM call runs is exactly that - and a flag
 * would then read "no stage" for one change-detection pass, which is long enough for the
 * mini-player to flash on and off again.</p>
 */
import {TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it} from 'vitest';
import {CallStagePresenceService} from './call-stage-presence.service';

describe('CallStagePresenceService', () => {
    let presence: CallStagePresenceService;

    beforeEach(() => {
        TestBed.resetTestingModule();
        presence = TestBed.inject(CallStagePresenceService);
    });

    it('reports nothing mounted to begin with, and reads a null key as "no"', () => {
        expect(presence.isMounted('channel:chan-1')).toBe(false);
        expect(presence.isMounted(null)).toBe(false);
    });

    it('answers per key, not per surface', () => {
        presence.register('channel:chan-1');

        expect(presence.isMounted('channel:chan-1')).toBe(true);
        expect(presence.isMounted('channel:chan-2')).toBe(false);
    });

    it('stays mounted while two registrations for one key overlap', () => {
        presence.register('call:call-1');
        presence.register('call:call-1');

        presence.unregister('call:call-1');
        expect(presence.isMounted('call:call-1')).toBe(true);

        presence.unregister('call:call-1');
        expect(presence.isMounted('call:call-1')).toBe(false);
    });
});
