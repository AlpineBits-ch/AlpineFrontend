import {computed, inject, Injectable, InjectionToken} from '@angular/core';
import type {Stripe} from '@stripe/stripe-js';
import {loadStripe} from '@stripe/stripe-js/pure';
import {EntitlementStore} from '../stores/entitlement.store';

/** Not interchangeable: `not_configured` renders no purchasing surface at all, `load_failed` is worth an error and a retry. */
export type StripeUnavailableReason = 'not_configured' | 'load_failed';

export interface StripeReady {
    stripe: Stripe;
    reason: null;
}

export interface StripeUnavailable {
    stripe: null;
    reason: StripeUnavailableReason;
}

/** Narrow on `stripe`: truthy is {@link StripeReady}, null carries a {@link StripeUnavailableReason}. */
export type StripeLoadResult = StripeReady | StripeUnavailable;

/** The signature of `loadStripe`, so a test can supply one that fails on demand. */
export type StripeJsLoader = (publishableKey: string) => Promise<Stripe | null>;

/**
 * How Stripe.js is fetched. Overridden only in tests.
 *
 * Must import `@stripe/stripe-js/pure`, not the package root: the root injects the script tag as
 * an import side effect, putting a third-party script on every launch.
 */
export const STRIPE_JS_LOADER = new InjectionToken<StripeJsLoader>('STRIPE_JS_LOADER', {
    providedIn: 'root',
    factory: () => (publishableKey: string) => loadStripe(publishableKey),
});

const NOT_CONFIGURED: StripeUnavailable = {stripe: null, reason: 'not_configured'};
const LOAD_FAILED: StripeUnavailable = {stripe: null, reason: 'load_failed'};

/**
 * Loads Stripe.js once, on demand, for whichever instance this client is pointed at.
 *
 * Never bundled or self-hosted: 3DS breaks unless `v3` is served from `https://js.stripe.com/v3/`.
 * The key is {@link EntitlementStore}'s `stripePublishableKey()` and nothing else, because it
 * decides whose Stripe account a card is charged on.
 */
@Injectable({providedIn: 'root'})
export class StripeLoaderService {
    private entitlements = inject(EntitlementStore);
    private loader = inject(STRIPE_JS_LOADER);

    /** The load in flight or already finished, keyed by publishable key: this client switches instance at runtime. */
    private attempt: {key: string; result: Promise<StripeLoadResult>} | null = null;

    /** Whether this instance has a publishable key at all; true is not permission to sell, the catalogue's `enabled` is the other half. */
    readonly configured = computed(() => this.publishableKey().length > 0);

    /** Stripe.js, or a reason there is none. Concurrent callers share one load; a failure is not memoised, which is what makes the retry button work. */
    load(): Promise<StripeLoadResult> {
        const key = this.publishableKey();
        if (!key) return Promise.resolve(NOT_CONFIGURED);

        if (this.attempt?.key === key) return this.attempt.result;

        const attempt: {key: string; result: Promise<StripeLoadResult>} = {
            key,
            result: Promise.resolve(NOT_CONFIGURED),
        };
        attempt.result = this.start(key, attempt);
        this.attempt = attempt;
        return attempt.result;
    }

    private async start(
        key: string,
        attempt: {key: string; result: Promise<StripeLoadResult>},
    ): Promise<StripeLoadResult> {
        try {
            const stripe = await this.loader(key);
            // `loadStripe` resolves null where there is no `window` to attach a script to. That is
            // still "the script did not arrive", and it is the same sentence to the user.
            if (stripe) return {stripe, reason: null};
        } catch {
            // Deliberately swallowed and turned into a reason. Stripe's own rejection is a bare
            // Error with a message about the script tag, which says nothing a user could act on.
        }
        if (this.attempt === attempt) this.attempt = null;
        return LOAD_FAILED;
    }

    private publishableKey(): string {
        return this.entitlements.stripePublishableKey()?.trim() ?? '';
    }
}
