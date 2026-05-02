import { Component, effect, ElementRef, inject, input, output, signal, untracked, ViewChild } from '@angular/core';
import { Button } from 'primeng/button';
import { GuildDto } from '../../../../../dtos/response/guild.dto';
import { GuildService } from '../../../../../services/guild.service';

@Component({
  selector: 'app-overview-settings',
  imports: [Button],
  templateUrl: './overview-settings.component.html',
})
export class OverviewSettingsComponent {
  readonly guild = input.required<GuildDto>();
  readonly guildUpdated = output<GuildDto>();

  @ViewChild('iconInput') private iconInputRef!: ElementRef<HTMLInputElement>;

  private guildService = inject(GuildService);

  protected name = signal('');
  protected description = signal('');
  protected iconPreview = signal<string | null>(null);
  protected saving = signal(false);

  constructor() {
    effect(() => {
      const g = this.guild();
      untracked(() => {
        this.name.set(g.name);
        this.description.set(g.description ?? '');
        this.iconPreview.set(g.iconUrl ?? null);
      });
    });
  }

  protected pickIcon(): void {
    this.iconInputRef.nativeElement.click();
  }

  protected onIconSelected(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => this.iconPreview.set(reader.result as string);
    reader.readAsDataURL(file);
  }

  protected removeIcon(): void {
    this.iconPreview.set(null);
    this.iconInputRef.nativeElement.value = '';
  }

  protected get iconLabel(): string {
    return (this.name() || this.guild().name).charAt(0).toUpperCase();
  }

  protected save(): void {
    const name = this.name().trim();
    if (!name || this.saving()) return;
    this.saving.set(true);
    this.guildService.updateGuild(this.guild().id, name, this.description().trim() || undefined).subscribe({
      next: updated => {
        this.guildUpdated.emit(updated);
        this.saving.set(false);
      },
      error: () => this.saving.set(false),
    });
  }
}
