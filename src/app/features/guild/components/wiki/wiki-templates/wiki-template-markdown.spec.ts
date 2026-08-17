import {renderWikiTemplate} from './wiki-template-markdown';
import {WikiTemplate} from './wiki-template.model';
import {WIKI_TEMPLATES} from './wiki-templates';

/** Stands in for `TranslateService.instant`: echoes the key so structure is what is asserted. */
const echo = (key: string) => key;

function template(blocks: WikiTemplate['blocks']): WikiTemplate {
    return {id: 't', icon: 'pi-file', nameKey: 'NAME', descriptionKey: 'DESC', blocks};
}

describe('renderWikiTemplate', () => {
    it('renders nothing for a template with no blocks', () => {
        expect(renderWikiTemplate(template([]), echo)).toBe('');
    });

    it('renders headings at their level', () => {
        const md = renderWikiTemplate(template([{kind: 'heading', level: 3, textKey: 'A'}]), echo);
        expect(md).toBe('### A\n');
    });

    // A single newline between blocks is a soft break, so the heading would be swallowed by the paragraph above it and never appear as a heading at all.
    it('separates blocks with a blank line', () => {
        const md = renderWikiTemplate(
            template([
                {kind: 'paragraph', textKey: 'P'},
                {kind: 'heading', level: 2, textKey: 'H'},
            ]),
            echo,
        );
        expect(md).toBe('P\n\n## H\n');
    });

    it('numbers an ordered list from one', () => {
        const md = renderWikiTemplate(template([{kind: 'ordered', itemKeys: ['A', 'B']}]), echo);
        expect(md).toBe('1. A\n2. B\n');
    });

    it('renders a task list as unchecked boxes', () => {
        const md = renderWikiTemplate(template([{kind: 'tasks', itemKeys: ['A']}]), echo);
        expect(md).toBe('- [ ] A\n');
    });

    it('quotes every line of a callout, including the marker', () => {
        const md = renderWikiTemplate(template([{kind: 'callout', variant: 'TIP', textKey: 'T'}]), echo);
        expect(md).toBe('> [!TIP]\n> T\n');
    });

    it('renders a table with a separator row and blank cells', () => {
        const md = renderWikiTemplate(
            template([
                {
                    kind: 'table',
                    headerKeys: ['H1', 'H2'],
                    rowKeys: [['A', '']],
                },
            ]),
            echo,
        );
        expect(md).toBe('| H1 | H2 |\n| --- | --- |\n| A |  |\n');
    });

    it('pads a short row out to the header width', () => {
        const md = renderWikiTemplate(
            template([
                {
                    kind: 'table',
                    headerKeys: ['H1', 'H2', 'H3'],
                    rowKeys: [['A']],
                },
            ]),
            echo,
        );
        expect(md).toContain('| A |  |  |');
    });

    // Both are things a translator can introduce without ever seeing the table.
    it('escapes pipes and flattens newlines inside a cell', () => {
        const md = renderWikiTemplate(
            template([
                {
                    kind: 'table',
                    headerKeys: ['H'],
                    rowKeys: [['X']],
                },
            ]),
            () => 'a | b\nc',
        );
        expect(md).toContain('| a \\| b c |');
    });

    it('fences a code block with its language', () => {
        const md = renderWikiTemplate(template([{kind: 'code', language: 'bash', lines: ['ls']}]), echo);
        expect(md).toBe('```bash\nls\n```\n');
    });
});

describe('WIKI_TEMPLATES', () => {
    it('has unique ids', () => {
        const ids = WIKI_TEMPLATES.map(t => t.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    // Blank is the escape hatch; anything else in that slot makes the picker feel mandatory.
    it('offers the blank template first', () => {
        expect(WIKI_TEMPLATES[0].id).toBe('blank');
        expect(WIKI_TEMPLATES[0].blocks.length).toBe(0);
    });

    it('renders every template without throwing', () => {
        for (const t of WIKI_TEMPLATES) {
            expect(() => renderWikiTemplate(t, echo)).not.toThrow();
        }
    });
});
