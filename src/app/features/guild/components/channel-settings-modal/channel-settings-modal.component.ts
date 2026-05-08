import {Component, inject, model, output, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {ChannelDto, GuildDto} from '../../../../dtos/response/guild.dto';
import {ChannelOverviewComponent} from './pages/channel-overview/channel-overview.component';
import {ChannelPermissionsComponent} from './pages/channel-permissions/channel-permissions.component';
import {GuildService} from '../../../../services/guild.service';
import {PrimeTemplate} from "primeng/api";

interface NavItem {
  id: string;
  label: string;
  icon: string;
}

@Component({
  selector: 'app-channel-settings-modal',
    imports: [NgClass, Dialog, Button, ChannelOverviewComponent, ChannelPermissionsComponent, PrimeTemplate],
  templateUrl: './channel-settings-modal.component.html',
})
export class ChannelSettingsModalComponent {
  isVisible = model.required<boolean>();

  channel = signal<ChannelDto | null>(null);
  guild = signal<GuildDto | null>(null);

  channelUpdated = output<ChannelDto>();
  channelDeleted = output<string>();

  private guildService = inject(GuildService);

  activePage = signal('overview');
  deleting = signal(false);
  confirmDelete = signal(false);

  navItems: NavItem[] = [
    {id: 'overview', label: 'Overview', icon: 'pi pi-sliders-h'},
    {id: 'permissions', label: 'Permissions', icon: 'pi pi-lock'},
  ];

  open(channel: ChannelDto, guild: GuildDto): void {
    this.channel.set(channel);
    this.guild.set(guild);
    this.activePage.set('overview');
    this.isVisible.set(true);
  }

  navItemClasses(id: string): Record<string, boolean> {
    const active = this.activePage() === id;
    return {
      'bg-indigo-500/15': active,
      'text-indigo-400': active,
      'text-white/50': !active,
    };
  }

  currentLabel(): string {
    return this.navItems.find(i => i.id === this.activePage())?.label ?? '';
  }

  onChannelUpdated(c: ChannelDto): void {
    this.channel.set(c);
    this.channelUpdated.emit(c);
  }

  deleteChannel(): void {
    const ch = this.channel();
    if (!ch || this.deleting()) return;
    this.deleting.set(true);
    this.guildService.deleteChannel(ch.id).subscribe({
      next: () => {
        this.channelDeleted.emit(ch.id);
        this.isVisible.set(false);
        this.confirmDelete.set(false);
        this.deleting.set(false);
      },
      error: () => this.deleting.set(false),
    });
  }
}
