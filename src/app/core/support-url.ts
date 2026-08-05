/**
 * Where the support and appeal pages live for a given instance.
 *
 * <p>Derived from the API host rather than configured, so a self-hosted instance gets its own
 * support site for free. <b>The first label is replaced, never prefixed</b>: an instance on
 * `api.venta.gg` prefixed would give `support.api.venta.gg`, a name with no DNS behind it, and
 * every link in the client would go nowhere. The server side shipped that bug once already.</p>
 *
 * <p>A self-hosted deployment can point the server's copy elsewhere with `SUPPORT_DOMAIN`, and the
 * client has no way to read it - so for such a deployment these links are wrong. That is tolerable
 * because the same derivation is the default on both sides, but the real fix is a
 * `/api/v1/configuration` field carrying the support URL. Nothing here hardcodes `venta.gg`, so
 * adopting that field later is a one-line change at the call sites.</p>
 */

export type SiteLabel = 'support' | 'docs' | 'admin' | 'status';

/**
 * `https://api.venta.gg` -> `https://support.venta.gg`; `https://venta.gg` -> `https://support.venta.gg`.
 *
 * <p>A bare domain, a single label and a bare IP get the label prefixed, because there is no
 * subdomain to replace. Anything with three or more labels has its first one swapped.</p>
 *
 * @returns the site origin, with no trailing slash. Falls back to the input when it is not a URL -
 *          a broken link is still better than throwing inside a template.
 */
export function siteHost(apiUrl: string, label: SiteLabel): string {
    let parsed: URL;
    try {
        parsed = new URL(apiUrl);
    } catch {
        return apiUrl;
    }

    const {hostname, protocol, port} = parsed;
    const labels = hostname.split('.');

    const host = labels.length < 3 || /^[\d.]+$/.test(hostname)
        ? `${label}.${hostname}`
        : [label, ...labels.slice(1)].join('.');

    return `${protocol}//${host}${port ? `:${port}` : ''}`;
}

/** The anonymous support site. Reachable while signed out, which is the whole point of it. */
export function supportUrl(apiUrl: string): string {
    return siteHost(apiUrl, 'support');
}

/**
 * The public platform status page, for the "see the real thing" link out of settings.
 *
 * <p>Only ever a destination. The status *data* is read from the API host like every other call -
 * see {@link import('../services/status-api.service').StatusApiService}.</p>
 */
export function statusUrl(apiUrl: string): string {
    return siteHost(apiUrl, 'status');
}

/** Where a restricted account files its one appeal. */
export function appealUrl(apiUrl: string): string {
    return `${siteHost(apiUrl, 'support')}/appeal`;
}
