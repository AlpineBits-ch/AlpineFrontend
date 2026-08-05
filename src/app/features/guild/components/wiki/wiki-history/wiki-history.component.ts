import {Component, effect, inject, input, output, signal} from '@angular/core';
import {DomSanitizer, SafeHtml} from '@angular/platform-browser';
import {Button} from 'primeng/button';
import {Tooltip} from 'primeng/tooltip';
import {WikiPageDto, WikiRevisionDto} from '../../../../../dtos/response/wiki.dto';
import {WikiService} from '../../../../../services/wiki.service';
import {formatWikiDate, renderWikiMarkdown} from '../wiki.utils';
import {WikiStateService} from '../wiki-state.service';
import {TranslateModule} from '@ngx-translate/core';

@Component({
    selector: 'app-wiki-history',
    imports: [Button, Tooltip, TranslateModule],
    templateUrl: './wiki-history.component.html',
})
export class WikiHistoryComponent {
    readonly page = input.required<WikiPageDto>();
    readonly guildId = input.required<string>();

    readonly back = output<void>();
    readonly restored = output<WikiPageDto>();
    protected revisions = signal<WikiRevisionDto[]>([]);
    protected loading = signal(false);
    protected restoringId = signal<string | null>(null);
    protected expandedRevId = signal<string | null>(null);
    protected readonly formatDate = formatWikiDate;
    protected readonly state = inject(WikiStateService);
    private readonly wikiService = inject(WikiService);
    private readonly sanitizer = inject(DomSanitizer);

    constructor() {
        effect(() => {
            const page = this.page();
            this.loading.set(true);
            this.revisions.set([]);
            this.wikiService.getRevisions(this.guildId(), page.id).subscribe({
                next: revs => {
                    this.revisions.set(revs);
                    this.loading.set(false);
                },
                error: () => this.loading.set(false),
            });
        });
    }

    protected togglePreview(revId: string): void {
        this.expandedRevId.update(id => id === revId ? null : revId);
    }

    protected renderContent(content: string): SafeHtml {
        return renderWikiMarkdown(content, this.sanitizer);
    }

    protected restoreRevision(revision: WikiRevisionDto): void {
        this.restoringId.set(revision.id);
        this.wikiService.restoreRevision(this.guildId(), this.page().id, revision.id).subscribe({
            next: page => {
                this.restoringId.set(null);
                this.restored.emit(page);
            },
            error: () => this.restoringId.set(null),
        });
    }
}
