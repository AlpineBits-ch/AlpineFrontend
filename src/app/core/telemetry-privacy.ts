/**
 * Keeping crash reports free of personal data (T0-4). Plain functions, not a service, so they can
 * run inside `Sentry.init` before Angular's injector exists.
 */

const INSTALL_ID_KEY = 'telemetry_install_id';

/** Field names scrubbed out of every event and breadcrumb, matched case-insensitively. */
const SENSITIVE_KEYS = [
    'email',
    'username',
    'user_name',
    'phone',
    'phonenumber',
    'phone_number',
    'password',
    'newpassword',
    'currentpassword',
    'token',
    'accesstoken',
    'refreshtoken',
    'access_token',
    'refresh_token',
    'authorization',
    'secret',
    'masterkey',
    'master_key',
    'recoverycode',
    'privatekey',
    'private_key',
];

const REDACTED = '[redacted]';

/** How deep to walk a payload before giving up. Guards against cyclic or pathological objects. */
const MAX_DEPTH = 6;

function isSensitiveKey(key: string): boolean {
    const normalized = key.toLowerCase().replace(/[-\s]/g, '');
    return SENSITIVE_KEYS.includes(normalized);
}

/** Returns a copy, never an in-place edit, with every sensitive key replaced by a marker. */
export function scrubValue(value: unknown, depth = 0): unknown {
    if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value;

    if (Array.isArray(value)) return value.map(entry => scrubValue(entry, depth + 1));

    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        result[key] = isSensitiveKey(key) ? REDACTED : scrubValue(entry, depth + 1);
    }
    return result;
}

/** Strips the query string and fragment off a URL, which is where reset tokens live. */
export function scrubUrl(url: string): string {
    const cut = url.search(/[?#]/);
    return cut === -1 ? url : url.slice(0, cut);
}

/** The per-install pseudonym used when the account has not consented to identified telemetry. */
export function installId(storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): string {
    const existing = storage.getItem(INSTALL_ID_KEY);
    if (existing) return existing;

    const generated = crypto.randomUUID();
    storage.setItem(INSTALL_ID_KEY, generated);
    return generated;
}

interface ScrubbableEvent {
    request?: {url?: string; data?: unknown; headers?: unknown; query_string?: unknown};
    extra?: unknown;
    contexts?: unknown;
    user?: unknown;
    breadcrumbs?: {data?: unknown; message?: string}[];
}

/** The `beforeSend` hook. Runs on every event, consent or not. */
export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
    if (event.request) {
        if (event.request.url) event.request.url = scrubUrl(event.request.url);
        // Bodies are disabled at init; this is the belt to that pair of braces.
        if (event.request.data !== undefined) event.request.data = REDACTED;
        if (event.request.query_string !== undefined) event.request.query_string = REDACTED;
        if (event.request.headers !== undefined) {
            event.request.headers = scrubValue(event.request.headers);
        }
    }

    if (event.extra !== undefined) event.extra = scrubValue(event.extra);
    if (event.contexts !== undefined) event.contexts = scrubValue(event.contexts);

    return event;
}

interface ScrubbableBreadcrumb {
    data?: unknown;
    message?: string;
    category?: string;
}

/** The `beforeBreadcrumb` hook. Breadcrumbs capture fetch URLs and console output verbatim. */
export function scrubBreadcrumb<T extends ScrubbableBreadcrumb>(breadcrumb: T): T {
    if (breadcrumb.data !== undefined) {
        const scrubbed = scrubValue(breadcrumb.data) as Record<string, unknown>;
        if (typeof scrubbed['url'] === 'string') scrubbed['url'] = scrubUrl(scrubbed['url']);
        breadcrumb.data = scrubbed;
    }
    return breadcrumb;
}
