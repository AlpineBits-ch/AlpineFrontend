import { Component, effect, inject } from '@angular/core';
import { Button } from 'primeng/button';
import { Tooltip } from 'primeng/tooltip';
import { WikiSidebarComponent } from '../wiki-sidebar/wiki-sidebar.component';
import { WikiStateService } from '../wiki-state.service';
import { NavigationService } from '../../../../main-page/navigation.service';

@Component({
  selector: 'app-wiki-panel',
  imports: [Button, Tooltip, WikiSidebarComponent],
  templateUrl: './wiki-panel.component.html',
})
export class WikiPanelComponent {
  protected readonly navService = inject(NavigationService);
  private readonly state = inject(WikiStateService);

  constructor() {
    effect(() => {
      const guildId = this.navService.wikiPanelGuildId();
      if (guildId) this.state.initialize(guildId);
    });
  }

  protected openNewPage(): void {
    const guildId = this.state.guildId();
    if (!guildId) return;
    this.state.openEditor();
    this.navService.showWikiContent(guildId);
  }
}
