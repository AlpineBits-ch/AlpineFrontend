import type {Appearance} from '@stripe/stripe-js';

/**
 * The theme the Payment Element is drawn with, read from the live custom properties. Never paste
 * hex values here: `ThemeService` overrides the palette at runtime.
 */

/** `--color-text-primary` and friends are `rgba(...)`, which is a colour Stripe accepts as-is. */
function token(styles: CSSStyleDeclaration, name: string): string | undefined {
    const value = styles.getPropertyValue(name).trim();
    return value.length > 0 ? value : undefined;
}

/**
 * Builds the appearance from whatever tokens the document currently resolves.
 *
 * @param root the element the custom properties are read off, `:root` in every real caller.
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

    // Stripe rejects a whole rule set over one unparseable colour.
    if (border) {
        appearance.rules = {
            '.Input': {border: `1px solid ${border}`, boxShadow: 'none'},
            '.Tab': {border: `1px solid ${border}`, boxShadow: 'none'},
        };
    }

    return appearance;
}
