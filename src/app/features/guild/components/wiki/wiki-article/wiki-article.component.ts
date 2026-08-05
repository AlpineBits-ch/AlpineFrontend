import {
    AfterViewInit,
    Component,
    effect,
    ElementRef,
    inject,
    input,
    OnDestroy,
    output,
    signal,
    ViewChild,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Editor} from '@tiptap/core';
import {WikiDto, WikiPageDto} from '../../../../../dtos/response/wiki.dto';
import {WikiService} from '../../../../../services/wiki.service';
import {FileService} from '../../../../../services/file.service';
import {Heading} from '../wiki-toc';
import {parseWikiHref} from '../wiki-links';
import {wikiExtensions} from './wiki-extensions';

@Component({
    selector: 'app-wiki-article',
    imports: [FormsModule],
    templateUrl: './wiki-article.component.html',
    styleUrl: './wiki-article.component.css',
    host: {class: 'flex flex-col flex-1 min-h-0 overflow-hidden'},
})
export class WikiArticleComponent implements AfterViewInit, OnDestroy {
    readonly page = input<WikiPageDto | null>(null);
    readonly wiki = input<WikiDto | null>(null);
    readonly guildId = input.required<string>();
    readonly editing = input(false);

    readonly saved = output<WikiPageDto>();
    readonly cancelled = output<void>();
    readonly headingsChanged = output<Heading[]>();
    readonly wikiLinkClicked = output<string>();
    readonly dirtyChanged = output<boolean>();

    @ViewChild('editorEl') editorEl?: ElementRef<HTMLDivElement>;
    @ViewChild('fileInputEl') fileInputEl?: ElementRef<HTMLInputElement>;

    protected readonly title = signal('');
    protected readonly saving = signal(false);

    private readonly wikiService = inject(WikiService);
    private readonly fileService = inject(FileService);
    private editor?: Editor;
    private clickHandler?: (e: MouseEvent) => void;

    constructor() {
        // Loading a different page replaces the document; toggling editing must not.
        effect(() => {
            const page = this.page();
            this.title.set(page?.title ?? '');
            if (this.editor) this.setContent(page?.content ?? '');
        });

        effect(() => {
            this.editor?.setEditable(this.editing());
        });

        // Which links are broken depends on the page list, not on the stored content, so it is
        // re-evaluated whenever that list changes rather than only on load.
        effect(() => {
            this.wiki();
            this.markBrokenLinks();
        });
    }

    /** The live editor, for the menu components that attach to it. */
    get instance(): Editor | undefined {
        return this.editor;
    }

    ngAfterViewInit(): void {
        if (!this.editorEl) return;
        this.editor = new Editor({
            element: this.editorEl.nativeElement,
            extensions: wikiExtensions('Start writing…'),
            editable: this.editing(),
            content: '',
            onUpdate: () => {
                this.dirtyChanged.emit(true);
                this.emitHeadings();
                this.markBrokenLinks();
            },
        });
        this.setContent(this.page()?.content ?? '');

        // Read mode keeps live anchors, so wiki: links must be intercepted before the browser
        // tries to resolve a protocol it does not know.
        this.clickHandler = (event: MouseEvent) => {
            const anchor = (event.target as HTMLElement).closest('a');
            if (!anchor) return;
            const pageId = parseWikiHref(anchor.getAttribute('href'));
            if (!pageId) return;
            event.preventDefault();
            this.wikiLinkClicked.emit(pageId);
        };
        this.editorEl.nativeElement.addEventListener('click', this.clickHandler);
    }

    ngOnDestroy(): void {
        if (this.clickHandler) {
            this.editorEl?.nativeElement.removeEventListener('click', this.clickHandler);
        }
        this.editor?.destroy();
    }

    markdown(): string {
        return (this.editor as unknown as { getMarkdown(): string } | undefined)?.getMarkdown() ?? '';
    }

    save(): void {
        if (this.saving() || !this.title().trim()) return;
        this.saving.set(true);
        const base = {title: this.title().trim(), content: this.markdown()};
        const editingId = this.page()?.id;
        const request = editingId
            ? this.wikiService.updatePage(this.guildId(), editingId, base)
            : this.wikiService.createPage(this.guildId(), base);
        request.subscribe({
            next: page => {
                this.saving.set(false);
                this.dirtyChanged.emit(false);
                this.saved.emit(page);
            },
            error: () => this.saving.set(false),
        });
    }

    protected onFilesSelected(event: Event): void {
        const input = event.target as HTMLInputElement;
        const files = input.files ? Array.from(input.files) : [];
        input.value = '';
        for (const file of files) this.uploadFile(file);
    }

    private uploadFile(file: File): void {
        if (!file.type.startsWith('image/')) return;
        const blobUrl = URL.createObjectURL(file);
        this.editor?.chain().focus().setImage({src: blobUrl, alt: file.name}).run();
        this.fileService.uploadFile(file).subscribe({
            next: attachment => this.replaceImageSrc(blobUrl, attachment.url, attachment.fileName),
            // A failed upload drops the placeholder rather than leaving a broken blob: URL that
            // renders as a broken image and saves as one.
            error: () => this.replaceImageSrc(blobUrl, '', ''),
        });
    }

    private replaceImageSrc(blobUrl: string, newSrc: string, alt: string): void {
        const editor = this.editor;
        if (!editor) return;
        const tr = editor.state.tr;
        let changed = false;
        editor.state.doc.descendants((node, pos) => {
            if (node.type.name === 'image' && node.attrs['src'] === blobUrl) {
                if (newSrc) {
                    tr.setNodeMarkup(pos, undefined, {...node.attrs, src: newSrc, alt});
                } else {
                    tr.delete(pos, pos + node.nodeSize);
                }
                changed = true;
                return false;
            }
            return true;
        });
        if (changed) editor.view.dispatch(tr);
        URL.revokeObjectURL(blobUrl);
    }

    /** Content is markdown, except for legacy pages saved as HTML before the markdown switch. */
    private setContent(content: string): void {
        if (!this.editor) return;
        if (!content) {
            this.editor.commands.setContent('');
        } else if (content.trimStart().startsWith('<')) {
            this.editor.commands.setContent(content);
        } else {
            this.editor.commands.setContent(content, {contentType: 'markdown'} as never);
        }
        this.emitHeadings();
        this.markBrokenLinks();
    }

    private emitHeadings(): void {
        const headings: Heading[] = [];
        this.editor?.state.doc.descendants(node => {
            if (node.type.name === 'heading') {
                headings.push({level: node.attrs['level'] as number, text: node.textContent});
            }
            return true;
        });
        this.headingsChanged.emit(headings);
    }

    /**
     * Flags links whose target no longer exists. Done as a DOM attribute pass rather than a
     * schema rule because the set of valid ids changes as pages are created and deleted, while
     * the stored content does not.
     */
    private markBrokenLinks(): void {
        const root = this.editorEl?.nativeElement;
        if (!root) return;
        const known = new Set((this.wiki()?.pages ?? []).map(p => p.id));
        root.querySelectorAll('a').forEach(anchor => {
            const pageId = parseWikiHref(anchor.getAttribute('href'));
            if (pageId === null) return;
            anchor.setAttribute('data-wiki-broken', String(!known.has(pageId)));
        });
    }
}
