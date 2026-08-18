import {AutoproxyMode, ChannelAutoproxyDto, GuildPersonaDto} from '../../../dtos/response/persona.dto';

/** A leading one suppresses proxying for a single message, and is stripped before send. */
export const PROXY_ESCAPE = '\\';

export interface ProxyTags {
    personaId: string;
    prefix?: string | null;
    suffix?: string | null;
}

/** Why the composer is about to speak as whoever it is about to speak as. */
export type ProxySource = 'none' | 'escaped' | 'explicit' | 'tag' | 'autoproxy';

export interface ProxyResolution {
    personaId: string | null;
    /** The body once the escape and any matched tags are gone, which is what gets stored. */
    content: string;
    source: ProxySource;
    /** The tags that were eaten, so the composer can grey exactly those characters. */
    matched: {prefix: string; suffix: string} | null;
}

export interface ProxyContext {
    /** Picked in the switcher. Outranks everything except the escape. */
    explicitPersonaId?: string | null;
    candidates: readonly ProxyTags[];
    autoproxy?: ChannelAutoproxyDto | null;
}

export function proxyTagsOf(entry: GuildPersonaDto): ProxyTags {
    return {
        personaId: entry.persona.id,
        prefix: entry.proxyPrefix,
        suffix: entry.proxySuffix,
    };
}

export function hasProxyTags(tags: ProxyTags): boolean {
    return !!tags.prefix || !!tags.suffix;
}

/** How a persona writes its tags in a list: `t:text`, `text -c`, or `[[text]]`. */
export function formatProxyTags(tags: Pick<ProxyTags, 'prefix' | 'suffix'>): string {
    if (!tags.prefix && !tags.suffix) return '';
    return `${tags.prefix ?? ''}text${tags.suffix ?? ''}`;
}

/**
 * The longest match wins, so `A:` and `AB:` can coexist even though the resolver would otherwise
 * find both in `AB: hello`.
 */
export function matchProxyTags(content: string, candidates: readonly ProxyTags[]): ProxyTags | null {
    let best: ProxyTags | null = null;
    let bestLength = -1;

    for (const candidate of candidates) {
        if (!hasProxyTags(candidate)) continue;
        const prefix = candidate.prefix ?? '';
        const suffix = candidate.suffix ?? '';
        if (content.length < prefix.length + suffix.length) continue;
        if (prefix && !content.startsWith(prefix)) continue;
        if (suffix && !content.endsWith(suffix)) continue;

        const length = prefix.length + suffix.length;
        if (length > bestLength) {
            best = candidate;
            bestLength = length;
        }
    }

    return best;
}

function stripTags(content: string, tags: ProxyTags): string {
    const prefix = tags.prefix ?? '';
    const suffix = tags.suffix ?? '';
    return content.slice(prefix.length, content.length - suffix.length).trim();
}

/**
 * Mirrors the send-path order in the API spec: escape, then explicit, then tags, then autoproxy.
 * The composer runs it before sending so the preview cannot disagree with what the server does.
 */
export function resolveProxy(content: string, context: ProxyContext): ProxyResolution {
    if (content.startsWith(PROXY_ESCAPE)) {
        return {
            personaId: null,
            content: content.slice(PROXY_ESCAPE.length),
            source: 'escaped',
            matched: null,
        };
    }

    if (context.explicitPersonaId) {
        return {personaId: context.explicitPersonaId, content, source: 'explicit', matched: null};
    }

    const tags = matchProxyTags(content, context.candidates);
    if (tags) {
        return {
            personaId: tags.personaId,
            content: stripTags(content, tags),
            source: 'tag',
            matched: {prefix: tags.prefix ?? '', suffix: tags.suffix ?? ''},
        };
    }

    const auto = context.autoproxy;
    if (auto && auto.mode !== AutoproxyMode.Off && auto.personaId) {
        return {personaId: auto.personaId, content, source: 'autoproxy', matched: null};
    }

    return {personaId: null, content, source: 'none', matched: null};
}

/**
 * Whether typing this pair would make an existing persona unreachable in this guild. The server
 * owns the constraint; this only stops the edit form offering a save that is going to 409.
 */
export function findTagCollision(
    tags: Pick<ProxyTags, 'prefix' | 'suffix'>,
    personaId: string,
    others: readonly ProxyTags[],
): ProxyTags | null {
    const prefix = tags.prefix ?? '';
    const suffix = tags.suffix ?? '';
    if (!prefix && !suffix) return null;

    return (
        others.find(
            other =>
                other.personaId !== personaId &&
                (other.prefix ?? '') === prefix &&
                (other.suffix ?? '') === suffix,
        ) ?? null
    );
}
