import { Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { switchMap } from 'rxjs';
import { ServerData, ServerIconComponent } from '../server-icon/server-icon.component';
import { NavigationService } from '../../../main-page/navigation.service';
import { GuildDto } from '../../../../dtos/response/guild.dto';
import { GuildService } from '../../../../services/guild.service';
import { CreateGuildModalComponent } from '../create-guild-modal/create-guild-modal.component';
import {NgClass} from "@angular/common";

@Component({
  selector: 'app-server-taskbar',
  imports: [ServerIconComponent, CreateGuildModalComponent, NgClass],
  templateUrl: './server-taskbar.component.html',
  styleUrl: './server-taskbar.component.css',
})
export class ServerTaskbarComponent implements OnInit {
  protected navService = inject(NavigationService);
  private guildService = inject(GuildService);
  private destroyRef = inject(DestroyRef);

  protected guilds = signal<GuildDto[]>([]);
  protected showCreateModal = signal(false);

  protected isDMsActive = computed(() => this.navService.workspace().type === 'dms');

  ngOnInit(): void {
    this.guildService.getGuilds().subscribe(guilds => this.guilds.set(guilds));

    this.guildService.guildJoined$.pipe(
      takeUntilDestroyed(this.destroyRef),
      switchMap(() => this.guildService.getGuilds()),
    ).subscribe(guilds => this.guilds.set(guilds));
  }

  protected serverIcons = computed<ServerData[]>(() => {
    const workspace = this.navService.workspace();
    return this.guilds().map(g => ({
      id: g.id,
      name: g.name,
      icon: g.iconUrl ?? '',
      isHome: false,
      isActive: workspace.type === 'server' && workspace.guild.id === g.id,
    }));
  });

  protected onGuildCreated(guild: GuildDto): void {
    this.guilds.update(gs => [...gs, guild]);
    this.navService.selectServer(guild);
  }
}
