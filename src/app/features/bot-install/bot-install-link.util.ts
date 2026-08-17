export interface InstallBotLinkParams {
    clientId: string;
    permissions: bigint;
    guildId?: string;
    redirectUri?: string;
    state?: string;
}

/** Parses a `venta://install-bot?...` deep link. Returns null if it isn't an
 *  install-bot link or is missing the required `client_id` param. */
export function parseInstallBotLink(url: string): InstallBotLinkParams | null {
    if (!url.includes('install-bot')) return null;

    const params = extractQueryParams(url);
    const clientId = params.get('client_id');
    if (!clientId) return null;

    let permissions = 0n;
    try {
        permissions = BigInt(params.get('permissions') || '0');
    } catch {
        permissions = 0n;
    }

    return {
        clientId,
        permissions,
        guildId: params.get('guild_id') ?? undefined,
        redirectUri: params.get('redirect_uri') ?? undefined,
        state: params.get('state') ?? undefined,
    };
}

function extractQueryParams(url: string): URLSearchParams {
    try {
        return new URL(url).searchParams;
    } catch {
        const queryIndex = url.indexOf('?');
        return new URLSearchParams(queryIndex === -1 ? '' : url.slice(queryIndex + 1));
    }
}
