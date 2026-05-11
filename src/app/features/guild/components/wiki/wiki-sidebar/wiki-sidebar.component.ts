import {Component, computed, inject, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {Dialog} from 'primeng/dialog';
import {InputText} from 'primeng/inputtext';
import {WikiCategoryDto, WikiPageDto, WikiPageSummaryDto} from '../../../../../dtos/response/wiki.dto';
import {WikiService} from '../../../../../services/wiki.service';
import {WikiStateService} from '../wiki-state.service';
import {NavigationService} from '../../../../main-page/navigation.service';
import {PrimeTemplate} from "primeng/api";

@Component({
  selector: 'app-wiki-sidebar',
    imports: [NgClass, FormsModule, Button, Dialog, InputText, PrimeTemplate],
  templateUrl: './wiki-sidebar.component.html',
})
export class WikiSidebarComponent {
  protected readonly state = inject(WikiStateService);
  private readonly navService = inject(NavigationService);
  private readonly wikiService = inject(WikiService);

  protected goHome(): void {
    this.state.openHome();
    this.navService.showWikiContent(this.state.guildId());
  }

  protected goPage(page: WikiPageSummaryDto): void {
    this.state.openPage(page);
    this.navService.showWikiContent(this.state.guildId());
  }

  protected sortedCategories = computed(() =>
    [...(this.state.wiki()?.categories ?? [])].sort((a, b) => a.position - b.position),
  );

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

  // ── Category dialog ────────────────────────────────────────────────────────
  protected showCategoryDialog = signal(false);
  protected newCategoryName = signal('');
  protected creatingCategory = signal(false);

  protected submitCreateCategory(): void {
    const guildId = this.state.guildId();
    if (this.creatingCategory() || !this.newCategoryName().trim() || !guildId) return;
    this.creatingCategory.set(true);
    this.wikiService
      .createCategory(guildId, {
        name: this.newCategoryName().trim(),
        position: this.state.wiki()?.categories.length ?? 0,
      })
      .subscribe({
        next: () => {
          this.creatingCategory.set(false);
          this.showCategoryDialog.set(false);
          this.newCategoryName.set('');
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
