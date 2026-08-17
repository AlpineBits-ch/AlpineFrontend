/**
 * Where the support and appeal pages live for a given instance, derived from the API host. The
 * first label is replaced, never prefixed.
 */

export type SiteLabel = 'support' | 'docs' | 'admin' | 'status';

/**
 * `https://api.venta.gg` -> `https://support.venta.gg`; `https://venta.gg` -> `https://support.venta.gg`.
 *
 * A bare domain, a single label and a bare IP get the label prefixed; three or more labels have
 * the first swapped.
 *
 * @returns the site origin, with no trailing slash. Falls back to the input when it is not a URL.
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

    const host =
        labels.length < 3 || /^[\d.]+$/.test(hostname)
            ? `${label}.${hostname}`
            : [label, ...labels.slice(1)].join('.');

    return `${protocol}//${host}${port ? `:${port}` : ''}`;
}

/** The anonymous support site. Reachable while signed out, which is the whole point of it. */
export function supportUrl(apiUrl: string): string {
    return siteHost(apiUrl, 'support');
}

/** The public platform status page. Only ever a link destination, never a data source. */
export function statusUrl(apiUrl: string): string {
    return siteHost(apiUrl, 'status');
}

/** Where a restricted account files its one appeal. */
export function appealUrl(apiUrl: string): string {
    return `${siteHost(apiUrl, 'support')}/appeal`;
}
