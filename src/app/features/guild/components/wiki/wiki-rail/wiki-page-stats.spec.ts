import {pageStats} from './wiki-page-stats';

describe('pageStats', () => {
    it('counts words in plain prose', () => {
        expect(pageStats('one two three').words).toBe(3);
    });

    it('reports nothing for an empty body', () => {
        expect(pageStats('')).toEqual({words: 0, characters: 0, minutes: 0});
    });

    it('reports nothing for a body that is only markup', () => {
        expect(pageStats('---\n\n|   |\n|---|\n').words).toBe(0);
    });

    // Heading and list markers are punctuation, not words - counting them inflates every
    // structured page.
    it('ignores heading, quote and list markers', () => {
        expect(pageStats('# Title\n\n- one\n- two\n\n> quoted').words).toBe(4);
    });

    // The label is what gets read; the target is machinery.
    it('counts a link label and not its target', () => {
        expect(pageStats('see [the setup guide](wiki:abc123def) now').words).toBe(5);
    });

    it('ignores an image entirely', () => {
        expect(pageStats('![a diagram of the pipeline](https://x.dev/a.png)').words).toBe(0);
    });

    it('drops emphasis markers rather than counting them as words', () => {
        expect(pageStats('**bold** and *italic*').words).toBe(3);
    });

    // Code in a fence is content somebody reads; only the fence itself is markup.
    it('counts the code inside a fence but not the fence', () => {
        expect(pageStats('```ts\nconst a = 1\n```').words).toBe(4);
    });

    it('strips html from pages saved before the markdown switch', () => {
        expect(pageStats('<p>two words</p>').words).toBe(2);
    });

    it('rounds reading time up from the first word', () => {
        expect(pageStats('one').minutes).toBe(1);
    });

    it('scales reading time with length', () => {
        const words = Array.from({length: 1000}, (_, i) => `w${i}`).join(' ');
        expect(pageStats(words).minutes).toBe(5);
    });
});
