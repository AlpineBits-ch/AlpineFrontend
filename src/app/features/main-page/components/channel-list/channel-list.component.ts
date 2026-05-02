import { Component, computed, inject, input, signal } from '@angular/core';
import { NgClass } from '@angular/common';
import { ChannelDto, ChannelType, GuildDto } from '../../../../dtos/response/guild.dto';
import { NavigationService } from '../../navigation.service';

@Component({
  selector: 'app-channel-list',
  imports: [NgClass],
  templateUrl: './channel-list.component.html',
})
export class ChannelListComponent {
  guild = input.required<GuildDto>();

  protected readonly ChannelType = ChannelType;
  protected navService = inject(NavigationService);

  private collapsedIds = signal(new Set<string>());

  protected uncategorizedText = computed(() =>
    this.guild().channels.filter(c => !c.categoryId && c.type === ChannelType.Text)
  );

  protected uncategorizedVoice = computed(() =>
    this.guild().channels.filter(c => !c.categoryId && c.type === ChannelType.Voice)
  );

  protected categoryChannels(categoryId: string): ChannelDto[] {
    return this.guild().channels.filter(c => c.categoryId === categoryId);
  }

  protected isActive(channel: ChannelDto): boolean {
    const view = this.navService.mainView();
    return view.type === 'channel' && view.channel.id === channel.id;
  }

  protected isCollapsed(id: string): boolean {
    return this.collapsedIds().has(id);
  }

  protected toggleCollapse(id: string): void {
    this.collapsedIds.update(set => {
      const next = new Set(set);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }
}
