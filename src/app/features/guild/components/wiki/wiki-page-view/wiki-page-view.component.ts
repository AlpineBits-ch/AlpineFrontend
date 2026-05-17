import {Component, computed, inject, input, output, signal} from '@angular/core';
import {DomSanitizer, SafeHtml} from '@angular/platform-browser';
import {Button} from 'primeng/button';
import {Dialog} from 'primeng/dialog';
import {WikiPageDto} from '../../../../../dtos/response/wiki.dto';
import {WikiService} from '../../../../../services/wiki.service';
import {formatWikiDate, renderWikiMarkdown, toggleNthCheckbox} from '../wiki.utils';
import {WikiStateService} from '../wiki-state.service';
import {TranslateModule} from '@ngx-translate/core';
import {Tooltip} from "primeng/tooltip";
import {PrimeTemplate} from "primeng/api";

@Component({
    selector: 'app-wiki-page-view',
    imports: [Button, Dialog, TranslateModule, Tooltip, PrimeTemplate],
    templateUrl: './wiki-page-view.component.html',
    host: {class: 'flex flex-col flex-1 min-h-0'},
})
export class WikiPageViewComponent {
    readonly page = input.required<WikiPageDto>();
    readonly guildId = input.required<string>();

    readonly edit = output<WikiPageDto>();
    readonly history = output<void>();
    readonly deleted = output<void>();
    protected showDeleteDialog = signal(false);
    protected deletingPage = signal(false);
    protected savingCheckbox = signal(false);
    protected readonly formatDate = formatWikiDate;
    private readonly wikiService = inject(WikiService);
    private readonly sanitizer = inject(DomSanitizer);
    protected renderedContent = computed<SafeHtml>(() =>
        renderWikiMarkdown(this.page().content, this.sanitizer),
    );
    private readonly state = inject(WikiStateService);

    protected onContentClick(event: MouseEvent): void {
        const target = event.target as HTMLInputElement;
        if (target.tagName !== 'INPUT' || target.type !== 'checkbox') return;
        if (this.savingCheckbox()) return;

        const contentEl = event.currentTarget as HTMLElement;
        const checkboxes = Array.from(contentEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
        const index = checkboxes.indexOf(target);
        if (index === -1) return;

        const newChecked = target.checked;
        const currentPage = this.page();
        const updatedContent = toggleNthCheckbox(currentPage.content, index, newChecked);
        if (updatedContent === currentPage.content) return;

        // Optimistic: update immediately so the checkbox feels instant
        this.state.selectedPage.set({...currentPage, content: updatedContent});
        this.state.suppressPageRefreshOnce(); // prevent WS event from showing page loader
        this.savingCheckbox.set(true);
        this.wikiService.updatePage(this.guildId(), currentPage.id, {content: updatedContent}).subscribe({
            next: page => {
                this.state.selectedPage.set(page);
                this.savingCheckbox.set(false);
            },
            error: () => {
                this.state.selectedPage.set(currentPage);
                this.savingCheckbox.set(false);
            },
        });
    }

    protected doDeletePage(): void {
        this.deletingPage.set(true);
        this.wikiService.deletePage(this.guildId(), this.page().id).subscribe({
            next: () => {
                this.deletingPage.set(false);
                this.showDeleteDialog.set(false);
                this.deleted.emit();
            },
            error: () => this.deletingPage.set(false),
        });
    }
}
