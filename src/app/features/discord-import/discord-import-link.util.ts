export interface DiscordImportLinkParams {
    jobId?: string;
    error?: string;
}

/** Parses a `venta://discord-import?jobId=...` (or `?error=...`) deep link. Returns null if it
 *  isn't a discord-import link or carries neither a jobId nor an error. */
export function parseDiscordImportLink(url: string): DiscordImportLinkParams | null {
    if (!url.includes('discord-import')) return null;

    const params = extractQueryParams(url);
    const jobId = params.get('jobId') ?? undefined;
    const error = params.get('error') ?? undefined;
    if (!jobId && !error) return null;

    return {jobId, error};
}

function extractQueryParams(url: string): URLSearchParams {
    try {
        return new URL(url).searchParams;
    } catch {
        const queryIndex = url.indexOf('?');
        return new URLSearchParams(queryIndex === -1 ? '' : url.slice(queryIndex + 1));
    }
}
