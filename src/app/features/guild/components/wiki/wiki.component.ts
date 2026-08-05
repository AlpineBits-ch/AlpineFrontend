import {Component, effect, inject, input, signal, viewChild} from '@angular/core';
import {Button} from 'primeng/button';
import {Dialog} from 'primeng/dialog';
import {PrimeTemplate} from 'primeng/api';
import {WikiStateService} from './wiki-state.service';
import {WikiNavComponent} from './wiki-nav/wiki-nav.component';
import {WikiArticleComponent} from './wiki-article/wiki-article.component';
import {WikiBreadcrumbsComponent} from './wiki-breadcrumbs/wiki-breadcrumbs.component';
import {WikiHistoryComponent} from './wiki-history/wiki-history.component';
import {WikiHomeComponent} from './wiki-home/wiki-home.component';
import {WikiPageDto} from '../../../../dtos/response/wiki.dto';
import {WikiService} from '../../../../services/wiki.service';
import {Heading} from './wiki-toc';

const NAV_WIDTH_KEY = 'wiki-nav-width';
const NAV_WIDTH_DEFAULT = 260;
const NAV_WIDTH_MIN = 200;
const NAV_WIDTH_MAX = 420;

@Component({
    selector: 'app-wiki',
    imports: [
        WikiNavComponent, WikiHomeComponent, WikiArticleComponent, WikiBreadcrumbsComponent,
        WikiHistoryComponent, Button, Dialog, PrimeTemplate,
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
    /** Fed by the article as its document changes; consumed by the context rail's TOC. */
    protected readonly headings = signal<Heading[]>([]);
    protected readonly showDeleteDialog = signal(false);
    protected readonly deleting = signal(false);
    /** The live article, so the breadcrumb bar's Save can reach into the editor. */
    protected readonly article = viewChild(WikiArticleComponent);

    private readonly wikiService = inject(WikiService);

    constructor() {
        effect(() => {
            const id = this.guildId();
            if (id) this.state.initialize(id);
        });
    }

    protected onEditorSaved(page: WikiPageDto): void {
        this.state.afterSaved(page);
    }

    protected openLinkedPage(pageId: string): void {
        const summary = this.state.wiki()?.pages.find(p => p.id === pageId);
        if (summary) this.state.openPage(summary);
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
