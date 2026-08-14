import {describe, expect, it} from 'vitest';
import {stripeAppearance} from './stripe-appearance';

/**
 * The Payment Element is an iframe on Stripe's origin, so none of our CSS reaches it and the
 * appearance object is the only way it stops looking like a white form in a dark app. What is
 * asserted here is that the colours come from the live tokens rather than from a second copy of the
 * palette pasted into a `.ts` file, which would be right for the default theme and silently wrong
 * for every theme a user applies at runtime.
 */
function element(tokens: Record<string, string>): HTMLElement {
    const host = document.createElement('div');
    for (const [name, value] of Object.entries(tokens)) host.style.setProperty(name, value);
    document.body.appendChild(host);
    return host;
}

describe('stripeAppearance', () => {
    it('takes its colours from the tokens the document currently resolves', () => {
        const host = element({
            '--color-brand': '#4B5BC4',
            '--color-card': '#161b27',
            '--color-border': '#252e42',
        });

        const appearance = stripeAppearance(host);

        expect(appearance.variables?.['colorPrimary']).toBe('#4B5BC4');
        expect(appearance.variables?.['colorBackground']).toBe('#161b27');
        expect(appearance.rules?.['.Input']?.['border']).toBe('1px solid #252e42');
    });

    /** A theme applied at runtime moves the token, and this has to follow it rather than a hex. */
    it('follows a token that was overridden', () => {
        const host = element({'--color-brand': '#ff0055'});

        expect(stripeAppearance(host).variables?.['colorPrimary']).toBe('#ff0055');
    });

    /**
     * The edge that matters on a first paint and in every unit test: Stripe rejects an empty
     * string as a colour, so a token that resolves to nothing is left out and its own theme fills
     * the gap.
     */
    it('omits a variable whose token resolves to nothing rather than sending an empty string', () => {
        const appearance = stripeAppearance(element({}));

        expect(appearance.theme).toBe('night');
        expect(appearance.variables?.['colorPrimary']).toBeUndefined();
        expect(appearance.rules).toBeUndefined();
    });

    it('still answers with a usable theme when there is no element to read at all', () => {
        expect(stripeAppearance(null).theme).toBe('night');
    });
});
