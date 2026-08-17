import {describe, expect, it, vi} from 'vitest';
import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import type {Stripe} from '@stripe/stripe-js';
import {EntitlementStore} from '../stores/entitlement.store';
import {STRIPE_JS_LOADER, StripeJsLoader, StripeLoaderService} from './stripe-loader.service';

/** Stripe.js is an opaque object to this service; only its identity is ever asserted. */
const STRIPE = {id: 'stripe'} as unknown as Stripe;

function setup(key: string, loader: StripeJsLoader) {
    const publishableKey = signal(key);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            {provide: EntitlementStore, useValue: {stripePublishableKey: publishableKey}},
            {provide: STRIPE_JS_LOADER, useValue: loader},
        ],
    });
    return {service: TestBed.inject(StripeLoaderService), publishableKey};
}

describe('StripeLoaderService - the normal case', () => {
    it('loads Stripe.js with the key the entitlement store resolved', async () => {
        const loader = vi.fn<StripeJsLoader>().mockResolvedValue(STRIPE);
        const {service} = setup('pk_live_instance', loader);

        const result = await service.load();

        expect(result.stripe).toBe(STRIPE);
        expect(result.reason).toBeNull();
        expect(loader).toHaveBeenCalledWith('pk_live_instance');
    });

    it('memoises, so two concurrent callers share one load', async () => {
        const loader = vi.fn<StripeJsLoader>().mockResolvedValue(STRIPE);
        const {service} = setup('pk_live_instance', loader);

        const [first, second] = await Promise.all([service.load(), service.load()]);
        const third = await service.load();

        expect(loader).toHaveBeenCalledTimes(1);
        expect(first.stripe).toBe(STRIPE);
        expect(second.stripe).toBe(STRIPE);
        expect(third.stripe).toBe(STRIPE);
    });

    it('reloads when the instance changes, rather than reusing another operator key', async () => {
        const loader = vi.fn<StripeJsLoader>().mockResolvedValue(STRIPE);
        const {service, publishableKey} = setup('pk_live_one', loader);
        await service.load();

        publishableKey.set('pk_live_two');
        await service.load();

        expect(loader).toHaveBeenCalledTimes(2);
        expect(loader).toHaveBeenLastCalledWith('pk_live_two');
    });
});

describe('StripeLoaderService - no key configured', () => {
    it('resolves not_configured rather than throwing: an instance that sells nothing is normal', async () => {
        const loader = vi.fn<StripeJsLoader>().mockResolvedValue(STRIPE);
        const {service} = setup('', loader);

        const result = await service.load();

        expect(result.stripe).toBeNull();
        expect(result.reason).toBe('not_configured');
        // The third-party script must not be fetched on an instance that has nothing to sell.
        expect(loader).not.toHaveBeenCalled();
        expect(service.configured()).toBe(false);
    });

    it('treats a blank key as absent - whitespace is not a Stripe account', async () => {
        const loader = vi.fn<StripeJsLoader>().mockResolvedValue(STRIPE);
        const {service} = setup('   ', loader);

        expect((await service.load()).reason).toBe('not_configured');
        expect(loader).not.toHaveBeenCalled();
    });
});

describe('StripeLoaderService - the load failing', () => {
    it('reports load_failed distinguishably when the script does not arrive', async () => {
        const loader = vi.fn<StripeJsLoader>()
            .mockRejectedValue(new Error('Failed to load Stripe.js'));
        const {service} = setup('pk_live_instance', loader);

        const result = await service.load();

        expect(result.stripe).toBeNull();
        // Not not_configured: this instance does sell, and our side is what broke.
        expect(result.reason).toBe('load_failed');
    });

    it('reports load_failed when the loader resolves null instead of rejecting', async () => {
        const loader = vi.fn<StripeJsLoader>().mockResolvedValue(null);
        const {service} = setup('pk_live_instance', loader);

        expect((await service.load()).reason).toBe('load_failed');
    });

    it('does not memoise a failure, so a retry is a real retry', async () => {
        const loader = vi.fn<StripeJsLoader>()
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValue(STRIPE);
        const {service} = setup('pk_live_instance', loader);

        expect((await service.load()).reason).toBe('load_failed');
        const second = await service.load();

        expect(loader).toHaveBeenCalledTimes(2);
        expect(second.stripe).toBe(STRIPE);
        expect(second.reason).toBeNull();
    });
});
