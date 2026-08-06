import {
    Component,
    computed,
    effect,
    HostListener,
    inject,
    input,
    signal,
    viewChild,
} from '@angular/core';
import {Button} from 'primeng/button';
import {TranslateModule} from '@ngx-translate/core';
import {Dialog} from 'primeng/dialog';
import {PrimeTemplate} from 'primeng/api';
import {WikiStateService} from './wiki-state.service';
import {WikiNavComponent} from './wiki-nav/wiki-nav.component';
import {WikiArticleComponent} from './wiki-article/wiki-article.component';
import {SaveStatus, WikiBreadcrumbsComponent} from './wiki-breadcrumbs/wiki-breadcrumbs.component';
import {WikiHistoryComponent} from './wiki-history/wiki-history.component';
import {WikiHomeComponent} from './wiki-home/wiki-home.component';
import {WikiPageDto} from '../../../../dtos/response/wiki.dto';
import {WikiService} from '../../../../services/wiki.service';
import {WikiContextRailComponent} from './wiki-rail/wiki-context-rail.component';
import {WikiSearchPaletteComponent} from './wiki-search/wiki-search-palette.component';
import {WikiAiDialogComponent} from './wiki-ai/wiki-ai-dialog.component';
import {WikiShareDialogComponent} from './wiki-share/wiki-share-dialog.component';
import {WikiTemplatePickerComponent} from './wiki-templates/wiki-template-picker.component';
import {WikiTemplateChoice} from './wiki-templates/wiki-template.model';
import {WikiShortcutsOverlayComponent} from './wiki-shortcuts/wiki-shortcuts-overlay.component';
import {WikiShortcutKeysDirective} from './wiki-shortcuts/wiki-shortcut-keys.directive';
import {WikiGraphComponent} from './wiki-graph/wiki-graph.component';
import {WikiAiAskComponent} from './wiki-ai/wiki-ai-ask.component';
import {WikiContentCacheService} from './wiki-content-cache.service';
import {AiAskSource} from '../../../../services/ai-provider';
import {applyHeadingIds, buildToc, Heading, TocEntry} from './wiki-toc';
import {canEditPage} from './wiki-permissions';

const NAV_WIDTH_KEY = 'wiki-nav-width';
const NAV_WIDTH_DEFAULT = 260;
const NAV_WIDTH_MIN = 200;
const NAV_WIDTH_MAX = 420;

@Component({
    selector: 'app-wiki',
    imports: [
        WikiNavComponent, WikiHomeComponent, WikiArticleComponent, WikiBreadcrumbsComponent,
        WikiContextRailComponent, WikiSearchPaletteComponent, WikiHistoryComponent,
        WikiAiDialogComponent, WikiShareDialogComponent, WikiTemplatePickerComponent,
        WikiShortcutsOverlayComponent, WikiShortcutKeysDirective, WikiGraphComponent,
        WikiAiAskComponent, Button, Dialog, PrimeTemplate, TranslateModule,
    ],
    templateUrl: './wiki.component.html',
    styleUrl: './wiki.component.css',
    host: {class: 'relative flex flex-1 min-w-0 h-full overflow-hidden'},
})
export class WikiComponent {
    readonly guildId = input.required<string>();

    protected readonly state = inject(WikiStateService);
    protected readonly navWidth = signal(readStoredWidth());
    protected readonly navCollapsed = signal(false);
    /**
     * Drawer state for windows narrower than the breakpoint each column needs.
     *
     * Separate from `navCollapsed`, which is a deliberate desktop choice to reclaim the column.
     * Folding the two together would mean a collapsed desktop column stayed collapsed when the
     * window narrowed, leaving the drawer shut with no control left to open it.
     */
    protected readonly navDrawerOpen = signal(false);
    protected readonly railDrawerOpen = signal(false);
    /** Fed by the article as its document changes; consumed by the context rail's TOC. */
    protected readonly headings = signal<Heading[]>([]);
    /** The live body while editing, so the rail's word count moves as you type. */
    protected readonly liveContent = signal<string | null>(null);
    protected readonly searchOpen = signal(false);
    protected readonly aiOpen = signal(false);
    protected readonly shareOpen = signal(false);
    protected readonly shortcutsOpen = signal(false);
    protected readonly askOpen = signal(false);
    protected readonly cache = inject(WikiContentCacheService);
    /** Tags the AI suggested and the user accepted, on their way to the rail's tag editor. */
    protected readonly aiSuggestedTags = signal<string[]>([]);

    /**
     * Every page whose body we actually hold, for the ask panel to rank. Bodies only: a title-only
     * page contributes nothing but a citation the model could hang a wrong claim on.
     */
    protected readonly askSources = computed<AiAskSource[]>(() => {
        const bodies = this.cache.content();
        return (this.state.wiki()?.pages ?? [])
            .map(page => ({id: page.id, title: page.title, content: bodies.get(page.id) ?? ''}))
            .filter(source => source.content.trim());
    });
    protected readonly saveStatus = signal<SaveStatus>('idle');
    protected readonly showDeleteDialog = signal(false);
    protected readonly deleting = signal(false);
    /** The live article, so the breadcrumb bar's Save can reach into the editor. */
    protected readonly article = viewChild(WikiArticleComponent);

    /**
     * Which page the single article element is showing. Editing a brand new page yields null,
     * which the article treats as an empty document rather than as "nothing to render".
     */
    protected readonly articlePage = computed(() =>
        this.state.wikiView() === 'editor' ? this.state.editingPage() : this.state.selectedPage(),
    );

    /** Context for the model: what else lives in this wiki, minus the page being written. */
    protected readonly siblingTitles = computed(() => {
        const currentId = this.articlePage()?.id;
        return (this.state.wiki()?.pages ?? [])
            .filter(p => p.id !== currentId)
            .map(p => p.title);
    });

    /** EditOwnWikiPages needs the page's author, so this is per-page rather than per-guild. */
    protected readonly canEditCurrent = computed(() => {
        const page = this.state.selectedPage() ?? this.state.editingPage();
        if (!page) return this.state.abilities().canCreate;
        return canEditPage(this.state.abilities(), page.authorId, this.state.ownUserId());
    });

    private readonly wikiService = inject(WikiService);

    constructor() {
        effect(() => {
            const id = this.guildId();
            if (id) this.state.initialize(id);
        });

        // Tapping a page in the drawer must not leave the drawer sitting over the page it just
        // opened. Reads both signals so it fires on a view change as well as a page change.
        effect(() => {
            this.state.selectedPage();
            this.state.wikiView();
            this.navDrawerOpen.set(false);
            this.railDrawerOpen.set(false);
        });
    }

    /**
     * Scoped to the wiki rather than the app: this listener only exists while a wiki view is
     * mounted, so ⌘K elsewhere in the app is unaffected.
     */
    @HostListener('document:keydown', ['$event'])
    protected onDocumentKeydown(event: KeyboardEvent): void {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            this.searchOpen.set(true);
            return;
        }
        if ((event.metaKey || event.ctrlKey) && event.key === '/') {
            event.preventDefault();
            this.askOpen.set(true);
            return;
        }
        // An overlay you cannot dismiss with Escape reads as a stuck one. Only consumed when a
        // drawer is actually open, so Escape keeps its meaning everywhere else in the wiki.
        if (event.key === 'Escape' && (this.navDrawerOpen() || this.railDrawerOpen())) {
            event.preventDefault();
            this.navDrawerOpen.set(false);
            this.railDrawerOpen.set(false);
        }
    }

    protected onEditorSaved(page: WikiPageDto): void {
        this.state.afterSaved(page);
    }

    /**
     * Stamps stable ids onto the rendered headings, which is what makes a link to a section
     * possible at all - ProseMirror renders headings with no id of its own.
     *
     * Deferred a tick because the editor reports its headings before the DOM holding them has been
     * laid out, and re-run on every update because ProseMirror rebuilds those nodes.
     */
    protected onHeadingsChanged(headings: Heading[]): void {
        this.headings.set(headings);
        setTimeout(() => applyHeadingIds(
            document.querySelector('.wiki-article-body'),
            buildToc(this.headings()),
        ));
    }

    /**
     * Opening from a page that is only being read switches to editing first.
     *
     * Generating into a document you cannot type into would leave the result nowhere to go, and
     * the article is the same element in both modes, so this costs nothing.
     */
    protected openAiDialog(): void {
        if (this.state.wikiView() !== 'editor') {
            // Same reason as `startAiPage`: no picker behind the dialog.
            this.state.openEditor(this.state.selectedPage() ?? undefined, undefined,
                {skipTemplatePicker: true});
        }
        this.aiOpen.set(true);
    }

    /** From the empty-wiki state: a brand new page with the dialog already open. */
    protected startAiPage(): void {
        // Skipped: the picker would open behind the AI dialog, and someone who asked for a draft
        // has already chosen how this page gets its first draft.
        this.state.openEditor(undefined, undefined, {skipTemplatePicker: true});
        this.aiOpen.set(true);
    }

    protected applyTemplate(choice: WikiTemplateChoice): void {
        this.state.templatePickerOpen.set(false);
        this.article()?.applyTemplate(choice);
    }

    /**
     * The dialog's primary action is now "write into the page": it emits the prompt and closes,
     * and the article streams it in behind its own keep/discard strip.
     */
    protected onAiStreamRequest(prompt: string): void {
        this.aiOpen.set(false);
        if (this.state.wikiView() === 'editor') {
            this.article()?.draftWithAi(prompt);
            return;
        }
        // Switching views recreates the article, so the call has to wait for it to exist.
        this.state.openEditor(this.state.selectedPage() ?? undefined, undefined,
            {skipTemplatePicker: true});
        setTimeout(() => this.article()?.draftWithAi(prompt));
    }

    protected onAiInsert(markdown: string): void {
        this.article()?.insertMarkdown(markdown);
    }

    protected onAiReplace(markdown: string): void {
        this.article()?.replaceMarkdown(markdown);
    }

    protected openLinkedPage(pageId: string): void {
        const summary = this.state.wiki()?.pages.find(p => p.id === pageId);
        if (summary) this.state.openPage(summary);
    }

    /**
     * Scrolls to a heading by its position in the document rather than by an id attribute.
     *
     * The rendered headings carry no ids - they come from ProseMirror, which owns that DOM - so
     * matching on slug text would break on two headings that share a title. `buildToc` emits in
     * document order, so the Nth entry is the Nth heading element.
     */
    protected scrollToHeading(entry: TocEntry): void {
        const index = buildToc(this.headings()).findIndex(e => e.id === entry.id);
        if (index < 0) return;
        const headings = document.querySelectorAll(
            '.wiki-article-body h1, .wiki-article-body h2, .wiki-article-body h3, ' +
            '.wiki-article-body h4, .wiki-article-body h5, .wiki-article-body h6',
        );
        headings[index]?.scrollIntoView({behavior: 'smooth', block: 'start'});
    }

    protected confirmDelete(): void {
        const page = this.state.selectedPage();
        if (!page || this.deleting()) return;
        this.deleting.set(true);
        this.wikiService.deletePage(this.guildId(), page.id).subscribe({
            next: () => {
                this.deleting.set(false);
                this.showDeleteDialog.set(false);
                this.state.afterDeleted();
            },
            error: () => this.deleting.set(false),
        });
    }

    /**
     * Pointer-move resize on document rather than the handle: the pointer routinely outruns a
     * few-pixel target during a drag, and listening on the handle alone drops the gesture the
     * moment it does.
     */
    protected startResize(event: MouseEvent): void {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = this.navWidth();

        const onMove = (move: MouseEvent) => {
            const next = Math.min(
                NAV_WIDTH_MAX,
                Math.max(NAV_WIDTH_MIN, startWidth + move.clientX - startX),
            );
            this.navWidth.set(next);
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            document.body.style.userSelect = '';
            try {
                localStorage.setItem(NAV_WIDTH_KEY, String(this.navWidth()));
            } catch {
                // Width simply does not persist. Not worth surfacing.
            }
        };
        // Without this the drag selects whatever page text it passes over.
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }
}

function readStoredWidth(): number {
    try {
        const stored = Number(localStorage.getItem(NAV_WIDTH_KEY));
        return Number.isFinite(stored) && stored >= NAV_WIDTH_MIN && stored <= NAV_WIDTH_MAX
            ? stored
            : NAV_WIDTH_DEFAULT;
    } catch {
        return NAV_WIDTH_DEFAULT;
    }
}
