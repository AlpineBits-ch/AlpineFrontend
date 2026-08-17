import {WikiTemplate, WikiTemplateBlock} from './wiki-template.model';

/** `TranslateService.instant` narrowed to what this file needs, so the renderer stays pure. */
export type TemplateTranslator = (key: string) => string;

/** Assembles a template into the markdown the article inserts. Blocks are joined by a blank line, not a single newline: markdown treats one newline as a soft break, so `## Agenda` directly under a paragraph would parse as part of it and never appear as a heading. */
export function renderWikiTemplate(template: WikiTemplate, t: TemplateTranslator): string {
    if (!template.blocks.length) return '';
    return template.blocks.map(block => renderBlock(block, t)).join('\n\n') + '\n';
}

function renderBlock(block: WikiTemplateBlock, t: TemplateTranslator): string {
    switch (block.kind) {
        case 'heading':
            return `${'#'.repeat(block.level)} ${t(block.textKey)}`;
        case 'paragraph':
            return t(block.textKey);
        case 'bullets':
            return block.itemKeys.map(key => `- ${t(key)}`).join('\n');
        case 'ordered':
            return block.itemKeys.map((key, i) => `${i + 1}. ${t(key)}`).join('\n');
        case 'tasks':
            return block.itemKeys.map(key => `- [ ] ${t(key)}`).join('\n');
        case 'quote':
            return `> ${t(block.textKey)}`;
        case 'callout':
            // Every line of an alert has to carry the quote marker, including the marker line.
            return `> [!${block.variant}]\n> ${t(block.textKey)}`;
        case 'table':
            return renderTable(block, t);
        case 'code':
            return ['```' + block.language, ...block.lines, '```'].join('\n');
        case 'divider':
            return '---';
    }
}

function renderTable(block: Extract<WikiTemplateBlock, {kind: 'table'}>, t: TemplateTranslator): string {
    const width = block.headerKeys.length;
    const header = row(block.headerKeys.map(key => cell(t(key))));
    const rule = row(Array(width).fill('---'));
    const body = block.rowKeys.map(cells => {
        // Padded to the header width: a short row silently drops columns in most renderers.
        const padded = Array.from({length: width}, (_, i) => cells[i] ?? '');
        return row(padded.map(key => (key ? cell(t(key)) : '')));
    });
    return [header, rule, ...body].join('\n');
}

function row(cells: readonly string[]): string {
    return `| ${cells.join(' | ')} |`;
}

/** A pipe in translated prose ends the cell early and shifts every column after it; a newline ends the table outright. Both are things a translator can introduce without ever seeing a table. */
function cell(text: string): string {
    return text
        .replace(/\s*\n\s*/g, ' ')
        .replace(/\|/g, '\\|')
        .trim();
}
