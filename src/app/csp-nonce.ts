/**
 * The per-response CSP nonce, read back off the element nginx stamps it into.
 * Must read `ngCspNonce`, not `.nonce`: browsers blank the real attribute once the document is parsed.
 */
export function cspNonce(): string | undefined {
    return document.querySelector('app-root')?.getAttribute('ngCspNonce') ?? undefined;
}
