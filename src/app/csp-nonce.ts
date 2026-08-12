/**
 * The per-response CSP nonce, read back off the element nginx stamps it into.
 *
 * <p>The web image serves `style-src 'self' 'nonce-<request id>'` with no `unsafe-inline`. PrimeNG
 * compiles its preset to CSS in the browser and injects it as `<style>` elements, so without the
 * nonce every one of them is refused with `style-src-elem`. That leaves Tailwind's stylesheet - a
 * real file, covered by `'self'` - applied while every PrimeNG component is unstyled: avatars
 * render at their intrinsic image size and buttons lose their chrome. It presents as a layout bug
 * and is not one.</p>
 *
 * <p>Tauri serves its own, different CSP, so this can only break in a browser. Under `ng serve` and
 * on desktop the attribute is absent and this returns `undefined`, which is what PrimeNG defaults
 * to anyway.</p>
 *
 * <p>`getAttribute('ngCspNonce')` and not `.nonce`: browsers blank the real `nonce` attribute once
 * the document is parsed, so the custom attribute Angular reads is the only one still legible from
 * script. `docker/web/nginx.conf` is the other half of this, and `csp-nonce.spec.ts` asserts the
 * two halves still line up.</p>
 *
 * <p>Its own module rather than a local in `app.config.ts` so a spec can exercise it without
 * importing the whole provider graph - Sentry included - just to read one attribute.</p>
 */
export function cspNonce(): string | undefined {
    return document.querySelector('app-root')?.getAttribute('ngCspNonce') ?? undefined;
}
