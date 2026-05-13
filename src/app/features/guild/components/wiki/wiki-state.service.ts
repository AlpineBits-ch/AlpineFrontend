import {inject, Injectable, signal} from '@angular/core';
import {WikiDto, WikiPageDto, WikiPageSummaryDto} from '../../../../dtos/response/wiki.dto';
import {WikiService} from '../../../../services/wiki.service';
import {WikiView} from './wiki.types';
import {GuildWebsocketService} from '../../../../services/guild-websocket.service';

@Injectable({providedIn: 'root'})
export class WikiStateService {
  private readonly wikiService = inject(WikiService);
  private readonly ws = inject(GuildWebsocketService);

  readonly wiki = signal<WikiDto | null>(null);
  readonly wikiView = signal<WikiView>('home');
  readonly selectedPage = signal<WikiPageDto | null>(null);
  readonly editingPage = signal<WikiPageDto | null>(null);
  readonly editorDefaults = signal<{categoryId?: string; parentPageId?: string} | null>(null);
  readonly guildId = signal<string>('');
  readonly pageLoading = signal(false);
  readonly pendingRemoteUpdate = signal<WikiPageDto | null>(null);
  private suppressNextPageRefresh = false;

  constructor() {
    this.ws.wikiPageCreatedObservable.subscribe(e => {
      if (e.guildId !== this.guildId()) return;
      this.loadWiki(this.guildId());
    });

    this.ws.wikiPageUpdatedObservable.subscribe(e => {
      if (e.guildId !== this.guildId()) return;
      this.loadWiki(this.guildId());

      if (this.wikiView() === 'page' && this.selectedPage()?.id === e.pageId) {
        if (this.suppressNextPageRefresh) {
          this.suppressNextPageRefresh = false;
          return;
        }
        this.pageLoading.set(true);
        this.wikiService.getPage(this.guildId(), e.pageId).subscribe({
          next: page => {
            this.selectedPage.set(page);
            this.pageLoading.set(false);
          },
          error: () => this.pageLoading.set(false),
        });
      }

      if (this.wikiView() === 'editor' && this.editingPage()?.id === e.pageId) {
        this.wikiService.getPage(this.guildId(), e.pageId).subscribe({
          next: page => this.pendingRemoteUpdate.set(page),
          error: () => {},
        });
      }
    });

    this.ws.wikiPageDeletedObservable.subscribe(e => {
      if (e.guildId !== this.guildId()) return;
      const affectsSelected = this.selectedPage()?.id === e.pageId;
      const affectsEditing  = this.editingPage()?.id === e.pageId;
      if (affectsSelected || affectsEditing) {
        this.selectedPage.set(null);
        this.editingPage.set(null);
        this.pendingRemoteUpdate.set(null);
        this.wikiView.set('home');
        this.pageLoading.set(false);
      }
      this.loadWiki(this.guildId());
    });

    this.ws.wikiCategoryCreatedObservable.subscribe(e => {
      if (e.guildId !== this.guildId()) return;
      this.loadWiki(this.guildId());
    });

    this.ws.wikiCategoryUpdatedObservable.subscribe(e => {
      if (e.guildId !== this.guildId()) return;
      this.loadWiki(this.guildId());
    });

    this.ws.wikiCategoryDeletedObservable.subscribe(e => {
      if (e.guildId !== this.guildId()) return;
      this.loadWiki(this.guildId());
    });
  }

  initialize(guildId: string): void {
    if (this.guildId() !== guildId) {
      this.guildId.set(guildId);
      this.wikiView.set('home');
      this.selectedPage.set(null);
      this.editingPage.set(null);
      this.pendingRemoteUpdate.set(null);
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

  openEditor(page?: WikiPageDto, defaults?: {categoryId?: string; parentPageId?: string}): void {
    this.editingPage.set(page ?? null);
    this.editorDefaults.set(page ? null : (defaults ?? null));
    this.pendingRemoteUpdate.set(null);
    this.wikiView.set('editor');
  }

  openHistory(): void {
    this.wikiView.set('history');
  }

  cancelEditor(): void {
    this.editorDefaults.set(null);
    this.pendingRemoteUpdate.set(null);
    const page = this.editingPage();
    if (page) {
      this.selectedPage.set(page);
      this.wikiView.set('page');
      this.pageLoading.set(false);
    } else {
      this.openHome();
    }
  }

  afterSaved(page: WikiPageDto): void {
    this.editorDefaults.set(null);
    this.pendingRemoteUpdate.set(null);
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

  suppressPageRefreshOnce(): void {
    this.suppressNextPageRefresh = true;
  }

  clearPendingRemoteUpdate(): void {
    this.pendingRemoteUpdate.set(null);
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
          const summary = wiki.pages.find(p => p.id === current.id);
          if (summary) this.selectedPage.update(p => p ? { ...p, ...summary } : p);
        }
      }
    });
  }
}
