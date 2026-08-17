import {parseWikiUrl, wikiShareLink, wikiSnippet, wikiUrl} from './wiki-link';

describe('wiki-link', () => {
    const guildId = 'guild-1';
    const pageId = 'page-2';

    it('round-trips a link', () => {
        expect(parseWikiUrl(wikiUrl(guildId, pageId))).toEqual({guildId, pageId});
    });

    // The brackets were the sender's opt-out from a server-side preview, added when the server had
    // no branch for an instance link and an unfurl would have scraped the web client's shell. It
    // resolves this shape in-process now, so bracketing would suppress the card it exists to get.
    it('shares the link bare, so the server attaches its card', () => {
        expect(wikiShareLink(guildId, pageId)).toBe(wikiUrl(guildId, pageId));
        expect(wikiShareLink(guildId, pageId)).not.toContain('<');
    });

    it('tolerates a trailing readable slug', () => {
        expect(parseWikiUrl(`${wikiUrl(guildId, pageId)}/getting-started`)).toEqual({guildId, pageId});
    });

    it('does not treat a link with trailing prose as a whole-message link', () => {
        expect(parseWikiUrl(`${wikiUrl(guildId, pageId)} have a look`)).toBeNull();
    });

    it('keeps the path shape the server recognises', () => {
        // `/wiki/{guildId}/{pageId}`. Live message history is full of this shape, and the server's
        // route table was written to match it - so it is pinned here rather than left to drift.
        expect(new URL(wikiUrl(guildId, pageId)).pathname).toBe(`/wiki/${guildId}/${pageId}`);
    });

    describe('wikiSnippet', () => {
        it('strips markdown down to prose', () => {
            expect(wikiSnippet('# Title\n\nSome **bold** and a [link](wiki:1).')).toBe(
                'Title Some bold and a link.',
            );
        });

        it('drops code fences whole', () => {
            expect(wikiSnippet('Before\n```ts\nconst x = 1;\n```\nAfter')).toBe('Before After');
        });

        it('drops a callout marker but keeps what the callout says', () => {
            expect(wikiSnippet('> [!NOTE]\n> Deploy from main only.')).toBe('Deploy from main only.');
        });

        it('reads a table as its cells, without the pipes or the rule row', () => {
            const table = '| Field | Value |\n| --- | --- |\n| Date | today |';
            expect(wikiSnippet(table)).toBe('Field Value Date today');
        });

        it('drops checkboxes from a task list', () => {
            expect(wikiSnippet('- [ ] first thing\n- [x] second thing')).toBe('first thing second thing');
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
