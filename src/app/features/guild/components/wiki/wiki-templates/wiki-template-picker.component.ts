import {ChangeDetectionStrategy, Component, HostListener, inject, input, output} from '@angular/core';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {WikiTemplate, WikiTemplateBlock, WikiTemplateChoice} from './wiki-template.model';
import {WIKI_TEMPLATES} from './wiki-templates';
import {renderWikiTemplate} from './wiki-template-markdown';

/** One line of the card thumbnail. Shapes, not markdown: the card is 15rem wide. */
export interface TemplatePreviewRow {
    shape: 'heading' | 'text' | 'bullet' | 'task' | 'quote' | 'grid';
    /** Resolved by the `translate` pipe in the view, so the card follows a language change. */
    textKey?: string;
    /** Literal text, for the one block kind that is not translated (code). */
    text?: string;
}

export interface TemplateCard {
    template: WikiTemplate;
    preview: readonly TemplatePreviewRow[];
}

const PREVIEW_ROWS = 5;

/**
 * The "what kind of page is this" step, shown once when a page is created. A full picker rather
 * than a dropdown on the editor, since this is the first surface a new page shows.
 *
 * Nothing here writes to the server: a choice is markdown handed to the editor as one undoable
 * insert, so picking the wrong template costs a ⌘Z.
 */
@Component({
    selector: 'app-wiki-template-picker',
    imports: [TranslateModule],
    templateUrl: './wiki-template-picker.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WikiTemplatePickerComponent {
    readonly open = input(false);

    readonly closed = output<void>();
    readonly chosen = output<WikiTemplateChoice>();

    protected readonly cards: readonly TemplateCard[] = WIKI_TEMPLATES.map(template => ({
        template,
        preview: buildPreview(template),
    }));

    /** Fixed cell count for the mini table thumbnail; index is unused beyond `track`. */
    protected readonly gridCells = [0, 1, 2, 3, 4, 5];

    private readonly translate = inject(TranslateService);

    /** On the document rather than the panel: the picker owns no focusable field to hang a keydown on, and Escape has to work before the user has clicked anything. */
    @HostListener('document:keydown', ['$event'])
    protected onKeydown(event: KeyboardEvent): void {
        if (!this.open() || event.key !== 'Escape') return;
        event.preventDefault();
        this.closed.emit();
    }

    protected choose(template: WikiTemplate): void {
        // `instant` at the moment of the click, not in a computed: this string is baked into the saved page, so it has to be the language the author is writing in right now.
        const t = (key: string) => this.translate.instant(key) as string;
        this.chosen.emit({
            templateId: template.id,
            markdown: renderWikiTemplate(template, t),
            suggestedTitle: template.blocks.length ? t(template.nameKey) : '',
        });
        this.closed.emit();
    }
}

function buildPreview(template: WikiTemplate): readonly TemplatePreviewRow[] {
    const rows: TemplatePreviewRow[] = [];
    for (const block of template.blocks) {
        if (rows.length >= PREVIEW_ROWS) break;
        rows.push(...previewRows(block));
    }
    return rows.slice(0, PREVIEW_ROWS);
}

function previewRows(block: WikiTemplateBlock): TemplatePreviewRow[] {
    switch (block.kind) {
        case 'heading':
            return [{shape: 'heading', textKey: block.textKey}];
        case 'paragraph':
            return [{shape: 'text', textKey: block.textKey}];
        case 'bullets':
        case 'ordered':
            return block.itemKeys.slice(0, 2).map(key => ({shape: 'bullet' as const, textKey: key}));
        case 'tasks':
            return block.itemKeys.slice(0, 2).map(key => ({shape: 'task' as const, textKey: key}));
        case 'quote':
        case 'callout':
            return [{shape: 'quote', textKey: block.textKey}];
        case 'table':
            return [{shape: 'grid'}];
        case 'code':
            return [{shape: 'text', text: block.lines[0] ?? ''}];
        // A rule carries no information at thumbnail size and would spend one of five rows.
        case 'divider':
            return [];
    }
}
