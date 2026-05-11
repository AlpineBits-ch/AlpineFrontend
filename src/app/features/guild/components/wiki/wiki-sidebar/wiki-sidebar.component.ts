import {Component, computed, inject, signal, ViewChild} from '@angular/core';
import {NgClass} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {Dialog} from 'primeng/dialog';
import {InputText} from 'primeng/inputtext';
import {Select} from 'primeng/select';
import {ContextMenu} from 'primeng/contextmenu';
import {MenuItem, PrimeTemplate} from 'primeng/api';
import {WikiCategoryDto, WikiPageDto, WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';
import {WikiService} from '../../../../../services/wiki.service';
import {WikiStateService} from '../wiki-state.service';
import {NavigationService} from '../../../../main-page/navigation.service';

export interface CategoryTreeNode {
  category: WikiCategoryDto;
  depth: number;
}

@Component({
  selector: 'app-wiki-sidebar',
  imports: [NgClass, FormsModule, Button, Dialog, InputText, Select, ContextMenu, PrimeTemplate],
  templateUrl: './wiki-sidebar.component.html',
})
export class WikiSidebarComponent {
  protected readonly state = inject(WikiStateService);
  private readonly navService = inject(NavigationService);
  private readonly wikiService = inject(WikiService);

  @ViewChild('catCtxMenu') private catCtxMenu?: ContextMenu;
  protected ctxMenuItems: MenuItem[] = [];

  protected goHome(): void {
    this.state.openHome();
    this.navService.showWikiContent(this.state.guildId());
  }

  protected goPage(page: WikiPageSummaryDto): void {
    this.state.openPage(page);
    this.navService.showWikiContent(this.state.guildId());
  }

  protected categoryTreeNodes = computed((): CategoryTreeNode[] => {
    const cats = this.state.wiki()?.categories ?? [];
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

  protected pinnedPages = computed(() =>
    (this.state.wiki()?.pages ?? []).filter(p => p.isPinned),
  );

  protected uncategorizedRootPages = computed(() =>
    (this.state.wiki()?.pages ?? []).filter(p => !p.categoryId && !p.parentPageId),
  );

  protected rootPages(categoryId: string): WikiPageSummaryDto[] {
    return (this.state.wiki()?.pages ?? []).filter(
      p => p.categoryId === categoryId && !p.parentPageId,
    );
  }

  protected childPages(parentPageId: string): WikiPageSummaryDto[] {
    return (this.state.wiki()?.pages ?? []).filter(p => p.parentPageId === parentPageId);
  }

  protected isPageActive(page: WikiPageSummaryDto): boolean {
    return this.state.wikiView() === 'page' && this.state.selectedPage()?.id === page.id;
  }

  protected onCategoryContextMenu(event: MouseEvent, category: WikiCategoryDto): void {
    event.preventDefault();
    this.ctxMenuItems = [
      {
        label: 'New Page Here',
        icon: 'pi pi-file-plus',
        command: () => {
          this.state.openEditor(undefined, {categoryId: category.id});
          this.navService.showWikiContent(this.state.guildId());
        },
      },
    ];
    this.catCtxMenu?.show(event);
  }

  protected onPageContextMenu(event: MouseEvent, page: WikiPageSummaryDto): void {
    event.preventDefault();
    const items: MenuItem[] = [
      {
        label: 'Add Article Here',
        icon: 'pi pi-file-plus',
        command: () => {
          this.state.openEditor(undefined, {categoryId: page.categoryId, parentPageId: page.id});
          this.navService.showWikiContent(this.state.guildId());
        },
      },
    ];
    const activePage = this.activePageForParenting();
    if (activePage && activePage.id !== page.id) {
      const truncated = activePage.title.length > 24 ? activePage.title.slice(0, 24) + '…' : activePage.title;
      items.push({
        label: `Set as parent of "${truncated}"`,
        icon: 'pi pi-sitemap',
        command: () => this.setAsParent(page, activePage),
      });
    }
    this.ctxMenuItems = items;
    this.catCtxMenu?.show(event);
  }

  private activePageForParenting(): WikiPageDto | null {
    const view = this.state.wikiView();
    if (view === 'page') return this.state.selectedPage();
    if (view === 'editor') return this.state.editingPage();
    return null;
  }

  private setAsParent(parentPage: WikiPageSummaryDto, childPage: WikiPageDto): void {
    const guildId = this.state.guildId();
    if (!guildId) return;
    this.wikiService.updatePage(guildId, childPage.id, {parentPageId: parentPage.id}).subscribe({
      next: () => this.state.reload(),
    });
  }

  // ── Category dialog ────────────────────────────────────────────────────────
  protected showCategoryDialog = signal(false);
  protected newCategoryName = signal('');
  protected newCategoryParentId = signal<string | undefined>(undefined);
  protected creatingCategory = signal(false);

  protected parentCategoryOptions = computed(() => [
    {label: 'None (root)', value: undefined},
    ...(this.state.wiki()?.categories ?? [])
      .sort((a, b) => a.position - b.position)
      .map(c => ({label: c.name, value: c.id})),
  ]);

  protected submitCreateCategory(): void {
    const guildId = this.state.guildId();
    if (this.creatingCategory() || !this.newCategoryName().trim() || !guildId) return;
    this.creatingCategory.set(true);
    const parentId = this.newCategoryParentId();
    const siblings = (this.state.wiki()?.categories ?? []).filter(
      c => c.parentCategoryId === parentId,
    );
    this.wikiService
      .createCategory(guildId, {
        name: this.newCategoryName().trim(),
        position: siblings.length,
        parentCategoryId: parentId,
      })
      .subscribe({
        next: () => {
          this.creatingCategory.set(false);
          this.showCategoryDialog.set(false);
          this.newCategoryName.set('');
          this.newCategoryParentId.set(undefined);
          this.state.reload();
        },
        error: () => this.creatingCategory.set(false),
      });
  }

  protected deleteCategory(category: WikiCategoryDto): void {
    const guildId = this.state.guildId();
    if (!guildId) return;
    this.wikiService.deleteCategory(guildId, category.id).subscribe({
      next: () => this.state.reload(),
    });
  }
}
