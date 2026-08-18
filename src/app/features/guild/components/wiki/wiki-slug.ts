/**
 * The published wiki's address is a hostname, not a path, so the grammar is DNS's rather than a
 * URL's. The rules are stricter in one way people trip over: an underscore is legal in a path and
 * illegal in a hostname.
 */

/** DNS caps a single label here. */
export const SLUG_MAX_LENGTH = 63;

/** Used until `GET .../publication` reports the instance's own zone. */
export const PUBLIC_WIKI_HOST_FALLBACK = 'wiki.venta.gg';

export type SlugProblem = 'empty' | 'too-long' | 'underscore' | 'invalid-character' | 'edge-hyphen';

export interface SlugCheck {
    valid: boolean;
    problem: SlugProblem | null;
    /** A sentence, never a regex. Null when there is nothing to say. */
    messageKey: string | null;
}

const VALID = /^[a-z0-9-]+$/;

const MESSAGES: Record<SlugProblem, string> = {
    empty: 'WIKI_PUBLISH.SLUG.EMPTY',
    'too-long': 'WIKI_PUBLISH.SLUG.TOO_LONG',
    underscore: 'WIKI_PUBLISH.SLUG.UNDERSCORE',
    'invalid-character': 'WIKI_PUBLISH.SLUG.INVALID_CHARACTER',
    'edge-hyphen': 'WIKI_PUBLISH.SLUG.EDGE_HYPHEN',
};

function problemOf(slug: string): SlugProblem | null {
    if (!slug) return 'empty';
    if (slug.length > SLUG_MAX_LENGTH) return 'too-long';
    // Called out separately: it is the one character people reach for that a path would accept.
    if (slug.includes('_')) return 'underscore';
    if (!VALID.test(slug)) return 'invalid-character';
    // Also catches a label of nothing but hyphens, which necessarily starts with one.
    if (slug.startsWith('-') || slug.endsWith('-')) return 'edge-hyphen';
    return null;
}

export function checkSlug(slug: string): SlugCheck {
    const problem = problemOf(slug.trim());
    return {
        valid: problem === null,
        problem,
        // An empty field is how the wiki is taken offline, so it is a state rather than a fault.
        messageKey: problem && problem !== 'empty' ? MESSAGES[problem] : null,
    };
}

/** What the field does to what is typed: a hostname is lowercase, and correcting that is not a rejection. */
export function normaliseSlugInput(raw: string): string {
    return raw.toLowerCase().replace(/\s+/g, '-').slice(0, SLUG_MAX_LENGTH);
}

/**
 * A guild name as a DNS label. Diacritics are folded rather than dropped, so `Cafe Solstråle`
 * becomes `cafe-solstrale` instead of `cafe-solstrle`.
 */
export function slugifyName(name: string): string {
    const folded = name
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();

    return folded
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, SLUG_MAX_LENGTH)
        .replace(/-$/, '');
}

const LEADING_ARTICLES = /^(the|a|an)-/;

/**
 * Near variants of a name that was taken, derived here and nowhere else: there is no availability
 * endpoint by design, so these are guesses to try, not answers.
 */
export function slugSuggestions(guildName: string, tried: string, taken: readonly string[] = []): string[] {
    const base = slugifyName(guildName);
    const short = base.replace(LEADING_ARTICLES, '');
    const stem = short || base;

    const candidates = [
        base,
        short,
        // The last word alone, which is usually the distinctive one: `the-ashfen-chronicle` -> `chronicle`.
        stem.split('-').slice(-1)[0],
        `${stem}-wiki`,
        `${stem}-rp`,
    ];

    const rejected = new Set([tried, ...taken]);
    const offered = new Set<string>();

    for (const raw of candidates) {
        const candidate = raw.replace(/^-|-$/g, '');
        if (!checkSlug(candidate).valid) continue;
        if (rejected.has(candidate) || offered.has(candidate)) continue;
        offered.add(candidate);
        if (offered.size === 3) break;
    }

    return [...offered];
}

export function publicWikiHost(slug: string, host: string | null | undefined): string {
    return `${slug}.${host || PUBLIC_WIKI_HOST_FALLBACK}`;
}

export function publicWikiUrl(slug: string, host: string | null | undefined): string {
    return `https://${publicWikiHost(slug, host)}`;
}

/** The zone a self-hosted instance serves wikis from, guessed from its API address. */
export function deriveWikiHost(apiBaseUrl: string): string {
    try {
        const apex = new URL(apiBaseUrl).hostname.replace(/^api\./, '');
        return `wiki.${apex}`;
    } catch {
        return PUBLIC_WIKI_HOST_FALLBACK;
    }
}
