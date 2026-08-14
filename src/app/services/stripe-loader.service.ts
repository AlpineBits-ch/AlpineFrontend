import {computed, inject, Injectable, InjectionToken} from '@angular/core';
import type {Stripe} from '@stripe/stripe-js';
import {loadStripe} from '@stripe/stripe-js/pure';
import {EntitlementStore} from '../stores/entitlement.store';

/**
 * Why there is no Stripe instance, when there is no Stripe instance.
 *
 * <p>Two reasons and they are not interchangeable. `not_configured` is a normal state - an instance
 * that sells nothing, or a self-hosted one - and the answer to it is to render no purchasing
 * surface at all, with no explanation and no retry. `load_failed` is a third-party script that did
 * not arrive: offline, a blocking extension, a content security policy missing
 * `https://js.stripe.com`. That one is worth saying out loud and worth a retry, because the user
 * did ask to buy something and it is our side that is broken.</p>
 *
 * <p>Collapsing the two into one "Stripe unavailable" is how an instance that never sold anything
 * starts telling people their payment form failed to load.</p>
 */
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
 * <p>The factory imports from `@stripe/stripe-js/pure` rather than the package root, and the
 * difference is the whole lazy-loading requirement: the root entry point injects the
 * `https://js.stripe.com/v3/` script tag as a side effect of being imported, so a single `import`
 * anywhere in the app would put a third-party script on every launch - including for the
 * overwhelming majority of users who will never buy anything. The `/pure` entry point defers it to
 * the first `loadStripe()` call, which is what {@link StripeLoaderService.load} is.</p>
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
 * <p><b>Never bundled and never self-hosted.</b> Stripe does not support serving `v3` from another
 * origin and 3DS breaks when it is; the script has to come from `https://js.stripe.com/v3/` at
 * runtime, which is what `loadStripe` does and what the CSP entries in
 * `docker/web/security-headers.conf.template` exist for.</p>
 *
 * <p>The key is {@link EntitlementStore}'s `stripePublishableKey()` and nothing else. It is already
 * the instance's own key with the compiled-in development one as a fallback, and reading
 * `environment.stripePublishableKey` here as well would be a second source of truth for a value
 * that decides whose Stripe account a card is charged on.</p>
 *
 * <p>Nothing here decides whether to show a buy button. That needs the catalogue's `enabled` too,
 * and this service only knows about half of it.</p>
 */
@Injectable({providedIn: 'root'})
export class StripeLoaderService {
    private entitlements = inject(EntitlementStore);
    private loader = inject(STRIPE_JS_LOADER);

    /**
     * The load in flight or already finished, and the key it was for.
     *
     * <p>Keyed rather than a bare promise: this client switches instance at runtime, and a Stripe
     * instance built from one operator's publishable key would go on being handed out after the
     * user moved to another operator's server.</p>
     */
    private attempt: {key: string; result: Promise<StripeLoadResult>} | null = null;

    /**
     * Whether this instance has a publishable key at all - the cheaper half of the two gates.
     *
     * <p>True is not permission to sell: the catalogue's `enabled` is the other half, and it is the
     * only one answered by the service that actually holds the secret key.</p>
     */
    readonly configured = computed(() => this.publishableKey().length > 0);

    /**
     * Stripe.js, or a reason there is none.
     *
     * <p>Concurrent callers share one load. A failed load is <b>not</b> memoised: the reasons it
     * fails are transient - a dropped connection, a blocked request, an extension that was turned
     * off since - so a second call after a failure tries again rather than answering from a cached
     * disappointment, which is what makes the UI's retry button do anything.</p>
     */
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
