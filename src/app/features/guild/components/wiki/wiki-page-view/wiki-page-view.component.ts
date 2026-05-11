import {Component, computed, inject, input, output, signal} from '@angular/core';
import {DomSanitizer, SafeHtml} from '@angular/platform-browser';
import {Button} from 'primeng/button';
import {Dialog} from 'primeng/dialog';
import {WikiPageDto} from '../../../../../dtos/response/wiki.dto';
import {WikiService} from '../../../../../services/wiki.service';
import {formatWikiDate, renderWikiMarkdown} from '../wiki.utils';

@Component({
  selector: 'app-wiki-page-view',
  imports: [Button, Dialog],
  templateUrl: './wiki-page-view.component.html',
})
export class WikiPageViewComponent {
  readonly page = input.required<WikiPageDto>();
  readonly guildId = input.required<string>();

  readonly edit = output<WikiPageDto>();
  readonly history = output<void>();
  readonly deleted = output<void>();

  private readonly wikiService = inject(WikiService);
  private readonly sanitizer = inject(DomSanitizer);

  protected showDeleteDialog = signal(false);
  protected deletingPage = signal(false);

  protected renderedContent = computed<SafeHtml>(() =>
    renderWikiMarkdown(this.page().content, this.sanitizer),
  );

  protected readonly formatDate = formatWikiDate;

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
