import {inject, Injectable, signal} from '@angular/core';
import {WikiDto, WikiPageDto, WikiPageSummaryDto} from '../../../../dtos/response/wiki.dto';
import {WikiService} from '../../../../services/wiki.service';
import {WikiView} from './wiki.types';

@Injectable({providedIn: 'root'})
export class WikiStateService {
  private readonly wikiService = inject(WikiService);

  readonly wiki = signal<WikiDto | null>(null);
  readonly wikiView = signal<WikiView>('home');
  readonly selectedPage = signal<WikiPageDto | null>(null);
  readonly editingPage = signal<WikiPageDto | null>(null);
  readonly guildId = signal<string>('');
  readonly pageLoading = signal(false);

  initialize(guildId: string): void {
    if (this.guildId() !== guildId) {
      this.guildId.set(guildId);
      this.wikiView.set('home');
      this.selectedPage.set(null);
      this.editingPage.set(null);
      this.pageLoading.set(false);
    }
    this.loadWiki(guildId);
  }

  openHome(): void {
    this.wikiView.set('home');
    this.selectedPage.set(null);
    this.pageLoading.set(false);
  }

  openPage(summary: WikiPageSummaryDto): void {
    this.selectedPage.set(null);
    this.pageLoading.set(true);
    this.wikiView.set('page');
    this.wikiService.getPage(this.guildId(), summary.id).subscribe({
      next: page => {
        this.selectedPage.set(page);
        this.pageLoading.set(false);
      },
      error: () => {
        this.pageLoading.set(false);
        this.openHome();
      },
    });
  }

  openEditor(page?: WikiPageDto): void {
    this.editingPage.set(page ?? null);
    this.wikiView.set('editor');
  }

  openHistory(): void {
    this.wikiView.set('history');
  }

  cancelEditor(): void {
    const page = this.editingPage();
    if (page) {
      // We already have the full page — no need to re-fetch
      this.selectedPage.set(page);
      this.wikiView.set('page');
      this.pageLoading.set(false);
    } else {
      this.openHome();
    }
  }

  afterSaved(page: WikiPageDto): void {
    this.loadWiki(this.guildId(), page);
  }

  afterDeleted(): void {
    this.selectedPage.set(null);
    this.pageLoading.set(false);
    this.wikiView.set('home');
    this.loadWiki(this.guildId());
  }

  afterRestored(page: WikiPageDto): void {
    this.loadWiki(this.guildId(), page);
  }

  reload(): void {
    this.loadWiki(this.guildId());
  }

  private loadWiki(guildId: string, navigateTo?: WikiPageDto): void {
    this.wikiService.getWiki(guildId).subscribe(wiki => {
      this.wiki.set(wiki);
      if (navigateTo) {
        this.selectedPage.set(navigateTo);
        this.wikiView.set('page');
        this.pageLoading.set(false);
      } else {
        const current = this.selectedPage();
        if (current) {
          // Merge refreshed summary metadata into the fetched full page, preserving content
          const summary = wiki.pages.find(p => p.id === current.id);
          if (summary) this.selectedPage.update(p => p ? { ...p, ...summary } : p);
        }
      }
    });
  }
}
