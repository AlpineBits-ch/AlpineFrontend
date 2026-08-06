/**
 * Page templates as structured blocks rather than as markdown strings.
 *
 * The obvious shape - one translation key holding a whole markdown document - was rejected: it
 * hands translators a page of syntax they can silently break (a lost pipe collapses a table, a
 * lost newline welds two headings into a paragraph), and it makes every template unreviewable in
 * a diff. Here each string is one short line of prose, the markdown is assembled by
 * `renderWikiTemplate`, and a translator cannot produce a document that fails to parse.
 *
 * The cost is that a template can only express what this union covers. That is the intended
 * bound: templates must stay inside what the editor round-trips through markdown, which is
 * headings, lists, task lists, tables, blockquotes, code blocks and rules.
 */

/** GitHub alert syntax. Rendered by W1's callout block; degrades to a plain quote without it. */
export type WikiCalloutVariant = 'NOTE' | 'TIP' | 'IMPORTANT' | 'WARNING' | 'CAUTION';

export type WikiTemplateBlock =
    | {kind: 'heading'; level: 1 | 2 | 3; textKey: string}
    | {kind: 'paragraph'; textKey: string}
    | {kind: 'bullets'; itemKeys: readonly string[]}
    | {kind: 'ordered'; itemKeys: readonly string[]}
    | {kind: 'tasks'; itemKeys: readonly string[]}
    | {kind: 'quote'; textKey: string}
    | {kind: 'callout'; variant: WikiCalloutVariant; textKey: string}
    /** An empty string is a blank cell - most template tables are a grid waiting to be filled. */
    | {kind: 'table'; headerKeys: readonly string[]; rowKeys: readonly (readonly string[])[]}
    /** Code is not prose, so its lines are literal rather than keyed. */
    | {kind: 'code'; language: string; lines: readonly string[]}
    | {kind: 'divider'};

export interface WikiTemplate {
    /** Stable across renames; used for the i18n namespace and as the `chosen` payload. */
    readonly id: string;
    readonly icon: string;
    readonly nameKey: string;
    readonly descriptionKey: string;
    readonly blocks: readonly WikiTemplateBlock[];
}

export interface WikiTemplateChoice {
    readonly templateId: string;
    /** The body to seed the editor with. Empty for the blank template. */
    readonly markdown: string;
    /** Offered as a starting title, so a new page is never called "Untitled". Empty for blank. */
    readonly suggestedTitle: string;
}
