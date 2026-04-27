import { Component, computed, inject, input } from '@angular/core';
import { ChannelDto, ChannelType, GuildDto } from '../../../../dtos/response/guild.dto';
import { NavigationService } from '../../navigation.service';

@Component({
  selector: 'app-channel-list',
  templateUrl: './channel-list.component.html',
})
export class ChannelListComponent {
  guild = input.required<GuildDto>();

  protected readonly ChannelType = ChannelType;
  protected navService = inject(NavigationService);

  protected textChannels = computed(() =>
    this.guild().channels.filter(c => c.type === ChannelType.Text)
  );

  protected voiceChannels = computed(() =>
    this.guild().channels.filter(c => c.type === ChannelType.Voice)
  );

  protected isActive(channel: ChannelDto): boolean {
    const view = this.navService.mainView();
    return view.type === 'channel' && view.channel.id === channel.id;
  }
}
