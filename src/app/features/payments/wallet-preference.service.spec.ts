import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {TestBed} from '@angular/core/testing';
import {installMemoryStorage} from '../../testing/memory-storage';
import {WalletPreferenceService} from './wallet-preference.service';
import {PaymentHandleKind} from './payment-handle.model';

/**
 * Rebuilt per call, because the choice is read once in the constructor - which is the whole point
 * of it: the settle-up sheet must not go back to storage on every render.
 */
function make(): WalletPreferenceService {
    TestBed.resetTestingModule();
    return TestBed.inject(WalletPreferenceService);
}

let restoreStorage: () => void;

beforeEach(() => {
    restoreStorage = installMemoryStorage();
});

afterEach(() => restoreStorage());

describe('WalletPreferenceService', () => {
    it('starts with no preference, which leaves the order alone', () => {
        expect(make().preferred()).toBeNull();
    });

    it('remembers a choice across a rebuild', () => {
        make().setPreferred(PaymentHandleKind.Revolut);
        expect(make().preferred()).toBe(PaymentHandleKind.Revolut);
    });

    it('clears a choice on null', () => {
        const service = make();
        service.setPreferred(PaymentHandleKind.PayPal);
        service.setPreferred(null);
        expect(make().preferred()).toBeNull();
    });

    it('ignores a stored value that is not a kind this build knows', () => {
        localStorage.setItem('alpine.payments.wallet', 'Swish');
        expect(make().preferred()).toBeNull();
    });

    it('survives storage being unavailable rather than failing to construct', () => {
        // A private window, a quota error, a disabled store. Losing the preference is survivable;
        // failing to build the service the settle-up sheet depends on is not.
        const spy = vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
            throw new Error('denied');
        });
        try {
            expect(make().preferred()).toBeNull();
        } finally {
            spy.mockRestore();
        }
    });
});

describe('WalletPreferenceService.order', () => {
    const handles = [
        {kind: PaymentHandleKind.Iban},
        {kind: PaymentHandleKind.PayPal},
        {kind: PaymentHandleKind.Revolut},
    ];

    it('keeps the owner order when nothing is preferred', () => {
        expect(make().order(handles).map(h => h.kind))
            .toEqual([PaymentHandleKind.Iban, PaymentHandleKind.PayPal, PaymentHandleKind.Revolut]);
    });

    it('lifts the preferred kind to the front and leaves the rest in place', () => {
        // A stable sort over one key: everything else keeps the order the owner listed it in,
        // which is the order they thought about and is not ours to shuffle.
        const service = make();
        service.setPreferred(PaymentHandleKind.Revolut);

        expect(service.order(handles).map(h => h.kind))
            .toEqual([PaymentHandleKind.Revolut, PaymentHandleKind.Iban, PaymentHandleKind.PayPal]);
    });

    it('hides nothing when the preferred kind is absent', () => {
        // Nothing is ever removed on the basis of a preference or a guess about what is installed:
        // a list one item too long is far better than one missing the wallet somebody has.
        const service = make();
        service.setPreferred(PaymentHandleKind.Venmo);
        expect(service.order(handles)).toHaveLength(3);
    });

    it('does not mutate the array it was given', () => {
        const service = make();
        service.setPreferred(PaymentHandleKind.Revolut);
        const original = [...handles];
        service.order(handles);
        expect(handles).toEqual(original);
    });
});
