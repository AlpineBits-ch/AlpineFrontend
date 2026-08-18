import {describe, expect, it} from 'vitest';
import {
    checkSlug,
    deriveWikiHost,
    normaliseSlugInput,
    publicWikiUrl,
    SLUG_MAX_LENGTH,
    slugifyName,
    slugSuggestions,
} from './wiki-slug';

describe('checkSlug', () => {
    it('accepts a plain label', () => {
        expect(checkSlug('ashfen').valid).toBe(true);
        expect(checkSlug('ashfen-chronicle-2').valid).toBe(true);
    });

    it('calls out an underscore on its own, because a path would have accepted it', () => {
        const result = checkSlug('my_wiki');
        expect(result.problem).toBe('underscore');
        expect(result.messageKey).toBe('WIKI_PUBLISH.SLUG.UNDERSCORE');
    });

    it('rejects a hyphen at either end', () => {
        expect(checkSlug('-ashfen').problem).toBe('edge-hyphen');
        expect(checkSlug('ashfen-').problem).toBe('edge-hyphen');
        expect(checkSlug('---').problem).toBe('edge-hyphen');
    });

    it('rejects anything a hostname cannot carry', () => {
        expect(checkSlug('ash fen').problem).toBe('invalid-character');
        expect(checkSlug('ashfen!').problem).toBe('invalid-character');
        expect(checkSlug('Ashfen').problem).toBe('invalid-character');
    });

    it('stops at the DNS label limit', () => {
        expect(checkSlug('a'.repeat(SLUG_MAX_LENGTH)).valid).toBe(true);
        expect(checkSlug('a'.repeat(SLUG_MAX_LENGTH + 1)).problem).toBe('too-long');
    });

    it('treats empty as a state rather than a fault, since it is how a wiki is unpublished', () => {
        const result = checkSlug('');
        expect(result.problem).toBe('empty');
        expect(result.messageKey).toBeNull();
    });
});

describe('normaliseSlugInput', () => {
    it('lowercases, because a hostname is lowercase and rejecting the shift key would be rude', () => {
        expect(normaliseSlugInput('AshFen')).toBe('ashfen');
    });

    it('turns typed spaces into hyphens', () => {
        expect(normaliseSlugInput('the ashfen chronicle')).toBe('the-ashfen-chronicle');
    });

    it('will not let the field exceed the label limit', () => {
        expect(normaliseSlugInput('a'.repeat(200))).toHaveLength(SLUG_MAX_LENGTH);
    });

    it('leaves an illegal character in place so it can be explained rather than silently eaten', () => {
        expect(normaliseSlugInput('my_wiki')).toBe('my_wiki');
    });
});

describe('slugifyName', () => {
    it('folds diacritics rather than dropping the letters', () => {
        expect(slugifyName('Café Solstråle')).toBe('cafe-solstrale');
    });

    it('collapses punctuation and runs of separators', () => {
        expect(slugifyName('The Ashfen  Chronicle: Book I')).toBe('the-ashfen-chronicle-book-i');
    });

    it('never produces an edge hyphen', () => {
        expect(slugifyName('  ...Ashfen!  ')).toBe('ashfen');
    });

    it('produces something a hostname will accept, or nothing at all', () => {
        const slug = slugifyName('日本語');
        expect(slug === '' || checkSlug(slug).valid).toBe(true);
    });
});

describe('slugSuggestions', () => {
    it('offers near variants of the guild name', () => {
        const offered = slugSuggestions('The Ashfen Chronicle', 'the-ashfen-chronicle');
        expect(offered.length).toBeGreaterThan(0);
        expect(offered.every(s => checkSlug(s).valid)).toBe(true);
    });

    it('never offers the name that was just refused', () => {
        expect(slugSuggestions('Ashfen', 'ashfen')).not.toContain('ashfen');
    });

    it('never offers one already known to be taken', () => {
        const offered = slugSuggestions('Ashfen', 'ashfen', ['ashfen-wiki']);
        expect(offered).not.toContain('ashfen-wiki');
    });

    it('offers at most three, and never a duplicate', () => {
        const offered = slugSuggestions('Ashfen', 'x');
        expect(offered.length).toBeLessThanOrEqual(3);
        expect(new Set(offered).size).toBe(offered.length);
    });

    it('drops the leading article, which is usually not how people say the name', () => {
        expect(slugSuggestions('The Ashfen Chronicle', 'the-ashfen-chronicle')).toContain('ashfen-chronicle');
    });
});

describe('publicWikiUrl', () => {
    it('puts the slug in front of the zone, as a hostname and not a path', () => {
        expect(publicWikiUrl('ashfen', 'wiki.venta.gg')).toBe('https://ashfen.wiki.venta.gg');
    });

    it('falls back to the default zone when the server has not said', () => {
        expect(publicWikiUrl('ashfen', null)).toBe('https://ashfen.wiki.venta.gg');
    });
});

describe('deriveWikiHost', () => {
    it('drops the api subdomain of a self-hosted instance', () => {
        expect(deriveWikiHost('https://api.example.org')).toBe('wiki.example.org');
    });

    it('falls back rather than throwing on something that is not a URL', () => {
        expect(deriveWikiHost('not a url')).toBe('wiki.venta.gg');
    });
});
