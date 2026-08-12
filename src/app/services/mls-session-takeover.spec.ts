import {TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it} from 'vitest';

import {asMlsSessionTakeover} from '../platform/mls-session';
import {MlsEngine} from '../platform/ports/mls-engine.port';
import {MlsLocalStoreFactory} from '../platform/ports/mls-local-store.port';
import {SecureStore} from '../platform/ports/secure-store.port';
import {FakeMlsEngine} from '../platform/testing/fake-mls-engine';
import {FakeMlsLocalStoreFactory} from '../platform/testing/fake-mls-local-store';
import {FakeSecureStore} from '../platform/testing/fake-secure-store';
import {DeviceIdentityService} from './device-identity.service';
import {MlsService} from './mls.service';

/**
 * The seam that carries "this tab has just been handed the account's engine" out of the platform layer.
 *
 * <p>Declared as an optional extension rather than widened into {@link MlsEngine}, the way the native
 * PTT hook is: a host with one process has no such event to report, because there is one engine and it
 * has been this tab's since the app started. So the shape is probed, and a desktop adapter yields an
 * observable that completes without emitting rather than one that never resolves.</p>
 */

/** A web adapter's shape: the port, plus the one thing only a browser has to say. */
class TakeoverCapableEngine extends FakeMlsEngine {
    private readonly listeners = new Set<() => void>();

    onSessionTakeover(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Stands for the browser granting this tab a lock request the other tab was holding. */
    handOver(): void {
        for (const listener of [...this.listeners]) listener();
    }

    /** How many listeners are still attached, so an unsubscribe can be proved rather than assumed. */
    get listening(): number {
        return this.listeners.size;
    }
}

describe('asMlsSessionTakeover', () => {
    it('finds the extension on an adapter that implements it', () => {
        expect(asMlsSessionTakeover(new TakeoverCapableEngine())).not.toBeNull();
    });

    it('answers null for an adapter that does not, rather than failing at the first call', () => {
        expect(asMlsSessionTakeover(new FakeMlsEngine())).toBeNull();
    });
});

describe('MlsService.sessionTakeovers', () => {
    let service: MlsService;
    let engine: TakeoverCapableEngine;

    function configure(mlsEngine: MlsEngine): MlsService {
        TestBed.resetTestingModule();
        TestBed.configureTestingModule({
            providers: [
                MlsService,
                {provide: MlsEngine, useValue: mlsEngine},
                {provide: SecureStore, useValue: new FakeSecureStore()},
                {provide: MlsLocalStoreFactory, useValue: new FakeMlsLocalStoreFactory()},
                {provide: DeviceIdentityService, useValue: {deviceId: async () => 'device-a'}},
            ],
        });
        return TestBed.inject(MlsService);
    }

    beforeEach(() => {
        engine = new TakeoverCapableEngine();
        service = configure(engine);
    });

    it('emits when the engine reports a takeover', () => {
        let handovers = 0;
        service.sessionTakeovers().subscribe(() => handovers++);

        engine.handOver();

        expect(handovers).toBe(1);
    });

    it('does not resolve the engine until something subscribes', () => {
        // The reason this is a method rather than a field: `MlsService` is reached transitively from a
        // dozen places that never touch an engine, and requiring an `MlsEngine` provider to construct
        // it is what took seven unrelated spec files down with "No provider found for MlsEngine".
        service.sessionTakeovers();

        expect(engine.listening).toBe(0);
    });

    it('detaches from the engine when the subscription ends', () => {
        const subscription = service.sessionTakeovers().subscribe();
        expect(engine.listening).toBe(1);

        subscription.unsubscribe();

        expect(engine.listening).toBe(0);
    });

    it('completes without emitting on a host that has one process', () => {
        const desktop = configure(new FakeMlsEngine());
        let emissions = 0;
        let completed = false;

        desktop.sessionTakeovers().subscribe({
            next: () => emissions++,
            complete: () => (completed = true),
        });

        expect(emissions).toBe(0);
        // Completing rather than hanging: a subscriber holding a subscription that can never fire is
        // indistinguishable from a broken wire, and this one is on the component's teardown list.
        expect(completed).toBe(true);
    });
});
