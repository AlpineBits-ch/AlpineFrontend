import {Component, computed, input, output} from '@angular/core';
import {Button} from 'primeng/button';
import {WikiCategoryDto, WikiDto, WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';
import {formatWikiDate} from '../wiki.utils';

export interface CategoryTreeNode {
  category: WikiCategoryDto;
  depth: number;
}

@Component({
  selector: 'app-wiki-home',
  imports: [Button],
  templateUrl: './wiki-home.component.html',
})
export class WikiHomeComponent {
  readonly wiki = input<WikiDto | null>(null);

  readonly openPage = output<WikiPageSummaryDto>();
  readonly newPage = output<void>();

  protected pinnedPages = computed(() =>
    (this.wiki()?.pages ?? []).filter(p => p.isPinned),
  );

  protected recentPages = computed(() =>
    [...(this.wiki()?.pages ?? [])]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 8),
  );

  protected categoryTreeNodes = computed((): CategoryTreeNode[] => {
    const cats = this.wiki()?.categories ?? [];
    const result: CategoryTreeNode[] = [];
    const buildTree = (parentId: string | undefined, depth: number) => {
      const children = cats
        .filter(c => (parentId === undefined ? !c.parentCategoryId : c.parentCategoryId === parentId))
        .sort((a, b) => a.position - b.position);
      for (const child of children) {
        result.push({category: child, depth});
        buildTree(child.id, depth + 1);
      }
    };
    buildTree(undefined, 0);
    return result;
  });

  protected rootPages(categoryId: string): WikiPageSummaryDto[] {
    return (this.wiki()?.pages ?? []).filter(
      p => p.categoryId === categoryId && !p.parentPageId,
    );
  }

  protected totalPages = computed(() => this.wiki()?.pages.length ?? 0);
  protected totalCategories = computed(() => this.wiki()?.categories.length ?? 0);

  protected readonly formatDate = formatWikiDate;
}
