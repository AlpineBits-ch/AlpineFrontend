import {Component, effect, inject, input} from '@angular/core';
import {WikiStateService} from './wiki-state.service';
import {WikiPageViewComponent} from './wiki-page-view/wiki-page-view.component';
import {WikiEditorComponent} from './wiki-editor/wiki-editor.component';
import {WikiHistoryComponent} from './wiki-history/wiki-history.component';
import {WikiHomeComponent} from './wiki-home/wiki-home.component';
import {WikiPageDto} from '../../../../dtos/response/wiki.dto';

@Component({
  selector: 'app-wiki',
  imports: [WikiHomeComponent, WikiPageViewComponent, WikiEditorComponent, WikiHistoryComponent],
  templateUrl: './wiki.component.html',
})
export class WikiComponent {
  readonly guildId = input.required<string>();

  protected readonly state = inject(WikiStateService);

  constructor() {
    effect(() => {
      const id = this.guildId();
      if (id) this.state.initialize(id);
    });
  }

  protected onEditorSaved(page: WikiPageDto): void {
    this.state.afterSaved(page);
  }
}
