import {Component, inject, input, OnInit, output, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Textarea} from 'primeng/textarea';
import {GuildDto} from '../../../../../../dtos/response/guild.dto';
import {GuildService, UpdateGuildDto} from '../../../../../../services/guild.service';

@Component({
  selector: 'app-overview-settings',
  imports: [FormsModule, Button, InputText, Textarea],
  templateUrl: './overview-settings.component.html',
})
export class OverviewSettingsComponent implements OnInit {
  guild = input.required<GuildDto>();
  guildUpdated = output<GuildDto>();

  private guildService = inject(GuildService);

  name = signal('');
  description = signal('');
  saving = signal(false);
  dirty = signal(false);

  iconPreview = signal<string | null>(null);
  pendingIconFile = signal<File | null>(null);

  ngOnInit(): void {
    this.name.set(this.guild().name);
    this.description.set(this.guild().description ?? '');
    this.iconPreview.set(this.guild().iconUrl ?? null);
  }

  onFieldChange(): void {
    const g = this.guild();
    this.dirty.set(
      this.name() !== g.name || this.description() !== (g.description ?? '')
    );
  }

  onIconSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.pendingIconFile.set(file);
    const reader = new FileReader();
    reader.onload = () => this.iconPreview.set(reader.result as string);
    reader.readAsDataURL(file);
    this.dirty.set(true);
  }

  removeIcon(): void {
    this.iconPreview.set(null);
    this.pendingIconFile.set(null);
    this.dirty.set(true);
  }

  save(): void {
    if (this.saving()) return;
    this.saving.set(true);

    const doUpdate = (g: GuildDto) => {
      const dto: UpdateGuildDto = {name: this.name(), description: this.description()};
      this.guildService.updateGuild(g.id, dto).subscribe({
        next: updated => {
          this.guildUpdated.emit(updated);
          this.dirty.set(false);
          this.saving.set(false);
        },
        error: () => this.saving.set(false),
      });
    };

    if (this.pendingIconFile()) {
      this.guildService.uploadGuildIcon(this.guild().id, this.pendingIconFile()!).subscribe({
        next: updated => {
          this.pendingIconFile.set(null);
          doUpdate(updated);
        },
        error: () => {
          this.saving.set(false);
        },
      });
    } else if (this.guild().iconUrl && !this.iconPreview()) {
      this.guildService.removeGuildIcon(this.guild().id).subscribe({
        next: updated => doUpdate(updated),
        error: () => this.saving.set(false),
      });
    } else {
      doUpdate(this.guild());
    }
  }
}
