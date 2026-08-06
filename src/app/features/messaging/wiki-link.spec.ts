import {parseWikiUrl, wikiShareLink, wikiSnippet, wikiUrl, wikiUrlPattern} from './wiki-link';

describe('wiki-link', () => {
    const guildId = 'guild-1';
    const pageId = 'page-2';

    it('round-trips a link', () => {
        expect(parseWikiUrl(wikiUrl(guildId, pageId))).toEqual({guildId, pageId});
    });

    it('shares the link bracketed, so the server does not unfurl it', () => {
        expect(wikiShareLink(guildId, pageId)).toBe(`<${wikiUrl(guildId, pageId)}>`);
    });

    it('tolerates a trailing readable slug', () => {
        expect(parseWikiUrl(`${wikiUrl(guildId, pageId)}/getting-started`))
            .toEqual({guildId, pageId});
    });

    it('does not treat a link with trailing prose as a whole-message link', () => {
        expect(parseWikiUrl(`${wikiUrl(guildId, pageId)} have a look`)).toBeNull();
    });

    it('finds every link in a body', () => {
        const text = `see ${wikiUrl('a', 'b')} and ${wikiUrl('c', 'd')}`;
        const found = [...text.matchAll(wikiUrlPattern())].map(m => [m[1], m[2]]);
        expect(found).toEqual([['a', 'b'], ['c', 'd']]);
    });

    it('returns an independent regex each call, so lastIndex cannot leak', () => {
        const one = wikiUrlPattern();
        one.exec(`${wikiUrl('a', 'b')}`);
        expect(wikiUrlPattern().lastIndex).toBe(0);
    });

    describe('wikiSnippet', () => {
        it('strips markdown down to prose', () => {
            expect(wikiSnippet('# Title\n\nSome **bold** and a [link](wiki:1).'))
                .toBe('Title Some bold and a link.');
        });

        it('drops code fences whole', () => {
            expect(wikiSnippet('Before\n```ts\nconst x = 1;\n```\nAfter')).toBe('Before After');
        });

        it('drops a callout marker but keeps what the callout says', () => {
            expect(wikiSnippet('> [!NOTE]\n> Deploy from main only.'))
                .toBe('Deploy from main only.');
        });

        it('reads a table as its cells, without the pipes or the rule row', () => {
            const table = '| Field | Value |\n| --- | --- |\n| Date | today |';
            expect(wikiSnippet(table)).toBe('Field Value Date today');
        });

        it('drops checkboxes from a task list', () => {
            expect(wikiSnippet('- [ ] first thing\n- [x] second thing'))
                .toBe('first thing second thing');
        });

        it('drops a setext underline rather than reading it as content', () => {
            expect(wikiSnippet('A Heading\n=========\n\nThe body.')).toBe('A Heading The body.');
        });

        /** The shape the Runbook template produces, which is what the report was actually about. */
        it('reads a templated page as prose', () => {
            const page = [
                '> [!NOTE]',
                '> One line on what this runbook is for.',
                '',
                '## Before you start',
                '',
                '- [ ] Access you need',
                '',
                '| Step | Owner |',
                '| --- | --- |',
                '| Deploy | ops |',
            ].join('\n');

            const snippet = wikiSnippet(page);

            expect(snippet).not.toContain('|');
            expect(snippet).not.toContain('[!');
            expect(snippet).not.toContain('[ ]');
            expect(snippet).not.toContain('---');
            expect(snippet).toContain('One line on what this runbook is for.');
        });

        it('truncates on a word boundary', () => {
            const snippet = wikiSnippet('alpha bravo charlie delta echo foxtrot', 20);
            expect(snippet.endsWith('…')).toBe(true);
            expect(snippet.length).toBeLessThanOrEqual(21);
        });
    });
});
