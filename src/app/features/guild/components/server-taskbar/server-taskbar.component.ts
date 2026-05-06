import { Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { switchMap } from 'rxjs';
import { ServerData, ServerIconComponent } from '../server-icon/server-icon.component';
import { NavigationService } from '../../../main-page/navigation.service';
import { GuildDto } from '../../../../dtos/response/guild.dto';
import { GuildService } from '../../../../services/guild.service';
import { GuildReadStateService } from '../../../../services/guild-read-state.service';
import { CreateGuildModalComponent } from '../create-guild-modal/create-guild-modal.component';
import { NgClass } from '@angular/common';
import { environment } from '../../../../../environments/environment';

@Component({
  selector: 'app-server-taskbar',
  imports: [ServerIconComponent, CreateGuildModalComponent, NgClass],
  templateUrl: './server-taskbar.component.html',
  styleUrl: './server-taskbar.component.css',
})
export class ServerTaskbarComponent implements OnInit {
  protected navService = inject(NavigationService);
  private guildService = inject(GuildService);
  private readStateService = inject(GuildReadStateService);
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

    this.guildService.guildUpdated$.pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(updated => {
      this.guilds.update(gs => gs.map(g => g.id === updated.id ? updated : g));
    });
  }

  protected serverIcons = computed<ServerData[]>(() => {
    const workspace = this.navService.workspace();
    const readStates = this.readStateService.channelStates();
    return this.guilds().map(g => {
      const totalMentions = g.channels.reduce(
        (sum, c) => sum + (readStates[c.id]?.mentionCount ?? 0), 0
      );
      return {
        id: g.id,
        name: g.name,
        icon: `${environment.apiUrl}/api/v1/guild/guilds/${g.id}/icon/thumbnail`,
        isHome: false,
        isActive: workspace.type === 'server' && workspace.guild.id === g.id,
        hasUnread: g.channels.some(c => readStates[c.id]?.isUnread ?? false),
        badge: totalMentions > 0 ? totalMentions : undefined,
      };
    });
  });

  protected onGuildCreated(guild: GuildDto): void {
    this.guilds.update(gs => [...gs, guild]);
    this.navService.selectServer(guild);
  }
}
