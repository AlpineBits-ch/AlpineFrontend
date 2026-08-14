import type {Appearance} from '@stripe/stripe-js';

/**
 * The theme the Payment Element is drawn with, derived from this app's own tokens.
 *
 * <p>The card field is an iframe on Stripe's origin, so none of our CSS reaches it - the only way it
 * stops looking like a white form pasted into a dark app is the `appearance` object. What it must
 * <b>not</b> be is a second copy of the palette: `--color-brand` is overridden at runtime by
 * `ThemeService`, so a hex pasted here would be right for the default theme and wrong for every
 * other one, and it would be wrong silently.</p>
 *
 * <p>So the values are read from the live custom properties. A token that resolves to nothing is
 * left out rather than defaulted, which is what makes this safe in a test environment and on a
 * first paint before the stylesheet has landed: Stripe's own `night` theme is a reasonable base and
 * an empty string is not a colour it can parse.</p>
 */

/** `--color-text-primary` and friends are `rgba(...)`, which is a colour Stripe accepts as-is. */
function token(styles: CSSStyleDeclaration, name: string): string | undefined {
    const value = styles.getPropertyValue(name).trim();
    return value.length > 0 ? value : undefined;
}

/**
 * Builds the appearance from whatever tokens the document currently resolves.
 *
 * @param root the element the custom properties are read off, `:root` in every real caller. Named
 *        so a test can hand in an element with known tokens instead of a whole stylesheet.
 */
export function stripeAppearance(root?: Element | null): Appearance {
    const element = root ?? (typeof document === 'undefined' ? null : document.documentElement);
    if (!element) return {theme: 'night'};

    const styles = getComputedStyle(element);
    const variables: Record<string, string> = {};

    const put = (key: string, value: string | undefined): void => {
        if (value !== undefined) variables[key] = value;
    };

    put('colorPrimary', token(styles, '--color-brand'));
    put('colorBackground', token(styles, '--color-card'));
    put('colorText', token(styles, '--color-text-primary'));
    put('colorTextSecondary', token(styles, '--color-text-secondary'));
    put('colorTextPlaceholder', token(styles, '--color-text-muted'));
    put('colorDanger', token(styles, '--color-offline'));
    put('fontFamily', token(styles, '--font-sans'));

    const border = token(styles, '--color-border');
    const appearance: Appearance = {
        theme: 'night',
        variables: {...variables, borderRadius: '0.75rem', spacingUnit: '4px'},
    };

    // A rule set with an unparseable colour in it is rejected wholesale by Stripe, so the border
    // rules exist only when there is a border colour to write into them.
    if (border) {
        appearance.rules = {
            '.Input': {border: `1px solid ${border}`, boxShadow: 'none'},
            '.Tab': {border: `1px solid ${border}`, boxShadow: 'none'},
        };
    }

    return appearance;
}
