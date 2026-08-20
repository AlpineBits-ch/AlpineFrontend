import {headingsFromMarkdown, normaliseExternalHref} from './wiki-link-target';

describe('headingsFromMarkdown', () => {
    it('reads every ATX heading with its level', () => {
        const headings = headingsFromMarkdown('# Setup\n\ntext\n\n## Rollback\n\n### Deep');

        expect(headings).toEqual([
            {id: 'setup', text: 'Setup', level: 1},
            {id: 'rollback', text: 'Rollback', level: 2},
            {id: 'deep', text: 'Deep', level: 3},
        ]);
    });

    it('ignores a # inside a fenced block', () => {
        const markdown = '# Real\n\n```bash\n# not a heading\n```\n\n## Also real';

        expect(headingsFromMarkdown(markdown).map(h => h.text)).toEqual(['Real', 'Also real']);
    });

    it('strips inline markup and the closing hashes', () => {
        const headings = headingsFromMarkdown('## **Bold** and `code` and [a link](http://x) ##');

        expect(headings[0].text).toBe('Bold and code and a link');
    });

    it('deduplicates ids the same way the table of contents does', () => {
        const headings = headingsFromMarkdown('# Notes\n\n# Notes');

        expect(headings.map(h => h.id)).toEqual(['notes', 'notes-2']);
    });

    it('answers nothing for a body with no headings', () => {
        expect(headingsFromMarkdown('just prose\n\nand more of it')).toEqual([]);
    });
});

describe('normaliseExternalHref', () => {
    it('adds https to a bare host', () => {
        expect(normaliseExternalHref('example.com')).toEqual({
            href: 'https://example.com',
            status: 'scheme-added',
        });
    });

    it('leaves an allowed scheme alone', () => {
        expect(normaliseExternalHref('https://example.com/a?b=1')).toEqual({
            href: 'https://example.com/a?b=1',
            status: 'ok',
        });
        expect(normaliseExternalHref('mailto:me@example.com').status).toBe('ok');
    });

    it('blocks a scheme outside the allowlist', () => {
        expect(normaliseExternalHref('javascript:alert(1)')).toEqual({href: '', status: 'blocked'});
        expect(normaliseExternalHref('file:///etc/passwd').status).toBe('blocked');
        // The page tab writes these, not the URL field.
        expect(normaliseExternalHref('wiki:0198abc').status).toBe('blocked');
    });

    it('turns a bare address into mailto', () => {
        expect(normaliseExternalHref('me@example.com')).toEqual({
            href: 'mailto:me@example.com',
            status: 'scheme-added',
        });
    });

    it('completes a protocol-relative href', () => {
        expect(normaliseExternalHref('//cdn.example.com/x.png')).toEqual({
            href: 'https://cdn.example.com/x.png',
            status: 'scheme-added',
        });
    });

    it('blocks what cannot resolve to a site', () => {
        expect(normaliseExternalHref('/docs/page').status).toBe('blocked');
        expect(normaliseExternalHref('#anchor').status).toBe('blocked');
        expect(normaliseExternalHref('two words').status).toBe('blocked');
        expect(normaliseExternalHref('   ').status).toBe('blocked');
    });
});
