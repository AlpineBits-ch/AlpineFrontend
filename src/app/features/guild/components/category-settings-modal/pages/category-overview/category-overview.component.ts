import {Component, inject, input, OnInit, output, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Textarea} from 'primeng/textarea';
import {CategoryDto} from '../../../../../../dtos/response/guild.dto';
import {GuildService, UpdateCategoryDto} from '../../../../../../services/guild.service';

@Component({
  selector: 'app-category-overview',
  imports: [FormsModule, Button, InputText, Textarea],
  templateUrl: './category-overview.component.html',
})
export class CategoryOverviewComponent implements OnInit {
  category = input.required<CategoryDto>();
  categoryUpdated = output<CategoryDto>();

  private guildService = inject(GuildService);

  name = signal('');
  description = signal('');
  saving = signal(false);
  dirty = signal(false);

  ngOnInit(): void {
    this.name.set(this.category().name);
    this.description.set(this.category().description ?? '');
    this.dirty.set(false);
  }

  onChange(): void {
    const c = this.category();
    this.dirty.set(
      this.name() !== c.name || this.description() !== (c.description ?? '')
    );
  }

  save(): void {
    if (this.saving()) return;
    this.saving.set(true);
    const dto: UpdateCategoryDto = {name: this.name(), description: this.description()};
    this.guildService.updateCategory(this.category().id, dto).subscribe({
      next: updated => {
        this.categoryUpdated.emit(updated);
        this.dirty.set(false);
        this.saving.set(false);
      },
      error: () => this.saving.set(false),
    });
  }
}
