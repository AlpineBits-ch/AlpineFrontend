import { Component, computed, inject, output } from '@angular/core';
import { ServerData, ServerIconComponent } from '../server-icon/server-icon.component';
import { Button } from 'primeng/button';
import { NavigationService } from '../../navigation.service';
import { ChannelType, GuildDto } from '../../../../dtos/response/guild.dto';

@Component({
  selector: 'app-server-taskbar',
  imports: [ServerIconComponent, Button],
  templateUrl: './server-taskbar.component.html',
  styleUrl: './server-taskbar.component.css',
})
export class ServerTaskbarComponent {
  public menuToggle = output();

  protected navService = inject(NavigationService);

  // Mock guild data — replace with API call when ready
  protected guilds: GuildDto[] = [
    {
      id: '1',
      name: 'UX Design',
      description: 'Design team workspace',
      ownerId: 'u1',
      iconUrl: '',
      bannerUrl: '',
      createdAt: new Date(),
      updatedAt: new Date(),
      roles: [],
      channels: [
        { id: 'c1', name: 'general',    description: '', type: ChannelType.Text,  guildId: '1', isAgeRestricted: false, isPrivate: false, createdAt: new Date(), updatedAt: new Date() },
        { id: 'c2', name: 'design-wip', description: '', type: ChannelType.Text,  guildId: '1', isAgeRestricted: false, isPrivate: false, createdAt: new Date(), updatedAt: new Date() },
        { id: 'c3', name: 'resources',  description: '', type: ChannelType.Text,  guildId: '1', isAgeRestricted: false, isPrivate: true,  createdAt: new Date(), updatedAt: new Date() },
        { id: 'c4', name: 'standup',    description: '', type: ChannelType.Voice, guildId: '1', isAgeRestricted: false, isPrivate: false, createdAt: new Date(), updatedAt: new Date() },
      ],
    },
    {
      id: '2',
      name: 'Gaming Hub',
      description: 'Gaming community',
      ownerId: 'u1',
      iconUrl: '',
      bannerUrl: '',
      createdAt: new Date(),
      updatedAt: new Date(),
      roles: [],
      channels: [
        { id: 'c5', name: 'general',   description: '', type: ChannelType.Text,  guildId: '2', isAgeRestricted: false, isPrivate: false, createdAt: new Date(), updatedAt: new Date() },
        { id: 'c6', name: 'lfg',       description: '', type: ChannelType.Text,  guildId: '2', isAgeRestricted: false, isPrivate: false, createdAt: new Date(), updatedAt: new Date() },
        { id: 'c7', name: 'game-room', description: '', type: ChannelType.Voice, guildId: '2', isAgeRestricted: false, isPrivate: false, createdAt: new Date(), updatedAt: new Date() },
      ],
    },
    {
      id: '3',
      name: 'Creators',
      description: 'Content creator hub',
      ownerId: 'u1',
      iconUrl: '',
      bannerUrl: '',
      createdAt: new Date(),
      updatedAt: new Date(),
      roles: [],
      channels: [
        { id: 'c8', name: 'announcements', description: '', type: ChannelType.Text,  guildId: '3', isAgeRestricted: false, isPrivate: false, createdAt: new Date(), updatedAt: new Date() },
        { id: 'c9', name: 'collab',        description: '', type: ChannelType.Text,  guildId: '3', isAgeRestricted: false, isPrivate: false, createdAt: new Date(), updatedAt: new Date() },
      ],
    },
  ];

  protected serverIcons = computed<ServerData[]>(() => {
    const workspace = this.navService.workspace();
    return this.guilds.map(g => ({
      id: g.id,
      name: g.name,
      icon: g.iconUrl ?? '',
      isHome: false,
      isActive: workspace.type === 'server' && workspace.guild.id === g.id,
    }));
  });
}
