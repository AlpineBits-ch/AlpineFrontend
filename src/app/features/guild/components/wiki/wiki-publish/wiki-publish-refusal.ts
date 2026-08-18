import {HttpErrorResponse} from '@angular/common/http';

/** The two reasons the server declines to put a page on the public host. */
export type WikiPublishRefusal = 'private' | 'cover';

/** The `error` field of the 400 body. Branch on this, never on `message`. */
const REFUSAL_BY_CODE: Record<string, WikiPublishRefusal> = {
    wiki_page_private: 'private',
    wiki_page_cover_not_hosted: 'cover',
};

export function publishRefusal(err: unknown): WikiPublishRefusal | null {
    if (!(err instanceof HttpErrorResponse) || err.status !== 400) return null;
    const code = (err.error as {error?: unknown} | null | undefined)?.error;
    return typeof code === 'string' ? (REFUSAL_BY_CODE[code] ?? null) : null;
}

/**
 * The host to name in the cover refusal. Null when there is nothing quotable: an app-relative
 * path, or a string that is not a URL at all.
 */
export function coverHost(url: string | null | undefined): string | null {
    const trimmed = url?.trim();
    if (!trimmed) return null;
    // A protocol-relative //host/x.png is refused like any other outside address, so name its host.
    if (trimmed.startsWith('//')) return parseHost(`https:${trimmed}`);
    if (trimmed.startsWith('/')) return null;
    return parseHost(trimmed);
}

function parseHost(value: string): string | null {
    try {
        return new URL(value).hostname || null;
    } catch {
        return null;
    }
}
