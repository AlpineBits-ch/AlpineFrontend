import {Component, effect, inject, input, output, signal} from '@angular/core';
import {Button} from 'primeng/button';
import {WikiPageDto, WikiRevisionDto} from '../../../../../dtos/response/wiki.dto';
import {WikiService} from '../../../../../services/wiki.service';
import {formatWikiDate} from '../wiki.utils';

@Component({
  selector: 'app-wiki-history',
  imports: [Button],
  templateUrl: './wiki-history.component.html',
})
export class WikiHistoryComponent {
  readonly page = input.required<WikiPageDto>();
  readonly guildId = input.required<string>();

  readonly back = output<void>();
  readonly restored = output<WikiPageDto>();

  private readonly wikiService = inject(WikiService);

  protected revisions = signal<WikiRevisionDto[]>([]);
  protected loading = signal(false);
  protected restoringId = signal<string | null>(null);

  protected readonly formatDate = formatWikiDate;

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
