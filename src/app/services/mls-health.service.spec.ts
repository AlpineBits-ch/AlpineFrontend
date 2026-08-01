import {TestBed} from '@angular/core/testing';
import {MlsHealthService} from './mls-health.service';

const CONTEXT = 'conv-1';

function setup(): MlsHealthService {
    TestBed.configureTestingModule({providers: [MlsHealthService]});
    return TestBed.inject(MlsHealthService);
}

describe('MlsHealthService', () => {
    it('reports nothing for a context that has never failed', () => {
        const health = setup();
        expect(health.hasFailures()).toBe(false);
        expect(health.healthOf(CONTEXT)).toBeNull();
        expect(health.isBroken(CONTEXT)).toBe(false);
    });

    it('does not call a single decrypt failure broken', () => {
        const health = setup();
        health.recordFailure(CONTEXT, false, 'decrypt-failed');

        // One failure is ordinary: a message paged in from beyond the ratchet's reach can never be
        // decrypted, and that is correct MLS behaviour rather than a fault worth alarming about.
        expect(health.hasFailures()).toBe(true);
        expect(health.isBroken(CONTEXT)).toBe(false);
    });

    it('calls a context broken once failures keep accruing', () => {
        const health = setup();
        for (let i = 0; i < 3; i++) health.recordFailure(CONTEXT, false, 'decrypt-failed');

        expect(health.healthOf(CONTEXT)?.failures).toBe(3);
        expect(health.isBroken(CONTEXT)).toBe(true);
    });

    it('treats never having been admitted as broken immediately', () => {
        const health = setup();
        health.recordFailure(CONTEXT, false, 'not-admitted');

        // Nothing about this improves by trying again: no amount of retrying admits a device that
        // was never added to the group, so the user needs the re-link affordance now.
        expect(health.isBroken(CONTEXT)).toBe(true);
    });

    it('treats being removed as broken immediately', () => {
        const health = setup();
        health.recordFailure(CONTEXT, true, 'removed');
        expect(health.isBroken(CONTEXT)).toBe(true);
    });

    it('restarts the count when the reason changes', () => {
        const health = setup();
        health.recordFailure(CONTEXT, false, 'decrypt-failed');
        health.recordFailure(CONTEXT, false, 'decrypt-failed');
        health.recordFailure(CONTEXT, false, 'join-failed');

        // "We were never admitted" and "one old message would not decrypt" are different problems
        // and must not add up into one count that crosses the threshold on their own.
        expect(health.healthOf(CONTEXT)?.reason).toBe('join-failed');
        expect(health.healthOf(CONTEXT)?.failures).toBe(1);
    });

    it('clears a context on the first success', () => {
        const health = setup();
        for (let i = 0; i < 5; i++) health.recordFailure(CONTEXT, false, 'decrypt-failed');

        health.recordSuccess(CONTEXT);

        expect(health.healthOf(CONTEXT)).toBeNull();
        expect(health.hasFailures()).toBe(false);
    });

    it('keeps contexts apart', () => {
        const health = setup();
        health.recordFailure('conv-a', false, 'not-admitted');
        health.recordFailure('chan-b', true, 'decrypt-failed');

        expect(health.isBroken('conv-a')).toBe(true);
        expect(health.isBroken('chan-b')).toBe(false);
        expect(health.unhealthy()).toHaveLength(2);
    });

    it('keeps the engine error for a details view without making it the message', () => {
        const health = setup();
        health.recordFailure(CONTEXT, false, 'join-failed', new Error('WrongEpoch: 4 != 7'));

        expect(health.healthOf(CONTEXT)?.detail).toBe('WrongEpoch: 4 != 7');
    });

    it('drops everything on a wipe', () => {
        const health = setup();
        health.recordFailure(CONTEXT, false, 'removed');
        health.clear();
        expect(health.hasFailures()).toBe(false);
    });
});
