import { Component, computed, DestroyRef, inject, OnInit, signal, ViewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { switchMap } from 'rxjs';
import { ServerData, ServerIconComponent } from '../server-icon/server-icon.component';
import { NavigationService } from '../../../main-page/navigation.service';
import { GuildDto } from '../../../../dtos/response/guild.dto';
import { GuildService } from '../../../../services/guild.service';
import { GuildReadStateService } from '../../../../services/guild-read-state.service';
import { GuildUiActionsService } from '../../../../services/guild-ui-actions.service';
import { CreateGuildModalComponent } from '../create-guild-modal/create-guild-modal.component';
import { NgClass } from '@angular/common';
import { environment } from '../../../../../environments/environment';
import { ContextMenu } from 'primeng/contextmenu';
import { MenuItem } from 'primeng/api';
import { GuildSettingsModalComponent } from '../guild-settings-modal/guild-settings-modal.component';
import { InviteType } from '../../../../dtos/response/invite.dto';
import { ProfileService } from '../../../../services/profile.service';

@Component({
  selector: 'app-server-taskbar',
  imports: [ServerIconComponent, CreateGuildModalComponent, NgClass, ContextMenu, GuildSettingsModalComponent],
  templateUrl: './server-taskbar.component.html',
  styleUrl: './server-taskbar.component.css',
})
export class ServerTaskbarComponent implements OnInit {
  protected navService = inject(NavigationService);
  private guildService = inject(GuildService);
  private readStateService = inject(GuildReadStateService);
  private guildUiActions = inject(GuildUiActionsService);
  private profileService = inject(ProfileService);
  private destroyRef = inject(DestroyRef);

  @ViewChild('guildContextMenu') private guildContextMenu!: ContextMenu;

  protected guilds = signal<GuildDto[]>([]);
  protected showCreateModal = signal(false);
  protected contextGuild = signal<GuildDto | null>(null);
  protected showGuildSettings = signal(false);

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

  protected onServerContextMenu(event: MouseEvent, guild: GuildDto): void {
    event.preventDefault();
    event.stopPropagation();
    this.contextGuild.set(guild);
    this.guildContextMenu.model = this.buildGuildMenuItems(guild);
    this.guildContextMenu.show(event);
  }

  protected onGuildSettingsUpdated(updated: GuildDto): void {
    this.guilds.update(gs => gs.map(g => g.id === updated.id ? updated : g));
  }

  private buildGuildMenuItems(guild: GuildDto): MenuItem[] {
    return [
      {
        label: 'Mark as Read',
        icon: 'pi pi-check-circle',
        command: () => this.markGuildAsRead(guild),
      },
      { separator: true },
      {
        label: 'Invite to Server',
        icon: 'pi pi-link',
        command: () => this.inviteToServer(guild),
      },
      { separator: true },
      {
        label: 'Mute Server',
        icon: 'pi pi-volume-off',
        command: () => {
          // TODO: Dominic — no per-guild mute API yet; needs backend support for mute state
        },
      },
      {
        label: 'Notification Settings',
        icon: 'pi pi-bell',
        command: () => {
          // TODO: Dominic — per-guild notification override (all / @mentions / nothing) not yet in API
        },
      },
      {
        label: 'Hide Muted Channels',
        icon: 'pi pi-eye-slash',
        command: () => {
          // TODO: Dominic — requires muted-channel state stored per member in backend or client-side prefs
        },
      },
      { separator: true },
      {
        label: 'Server Settings',
        icon: 'pi pi-cog',
        command: () => this.showGuildSettings.set(true),
      },
      {
        label: 'Privacy Settings',
        icon: 'pi pi-lock',
        command: () => {
          // TODO: Dominic — privacy settings page/modal not yet implemented
        },
      },
      {
        label: 'Edit Per-server Profile',
        icon: 'pi pi-user-edit',
        command: () => {
          // TODO: Dominic — per-guild profile overrides (nickname, avatar) not yet implemented
        },
      },
      { separator: true },
      {
        label: 'Create Channel',
        icon: 'pi pi-plus',
        command: () => this.triggerCreateChannel(guild),
      },
      {
        label: 'Create Category',
        icon: 'pi pi-folder-plus',
        command: () => this.triggerCreateCategory(guild),
      },
      {
        label: 'Create Event',
        icon: 'pi pi-calendar-plus',
        command: () => {
          // TODO: Dominic — events feature not yet implemented
        },
      },
      { separator: true },
      {
        label: 'Leave Server',
        icon: 'pi pi-sign-out',
        styleClass: 'text-rose-400',
        command: () => this.leaveServer(guild),
      },
    ];
  }

  private markGuildAsRead(guild: GuildDto): void {
    for (const channel of guild.channels) {
      this.readStateService.markChannelRead(channel.id);
    }
  }

  private inviteToServer(guild: GuildDto): void {
    this.guildService.createInvite({ type: InviteType.Permanent }, guild.id).subscribe({
      next: invite => navigator.clipboard.writeText(`https://venta.gg/invite/${invite.id}`),
    });
  }

  private triggerCreateChannel(guild: GuildDto): void {
    this.navService.selectServer(guild);
    setTimeout(() => this.guildUiActions.requestCreateChannel(), 0);
  }

  private triggerCreateCategory(guild: GuildDto): void {
    this.navService.selectServer(guild);
    setTimeout(() => this.guildUiActions.requestCreateCategory(), 0);
  }

  private leaveServer(guild: GuildDto): void {
    const ownUserId = this.profileService.ownProfile()?.userId;
    if (!ownUserId) return;
    this.guildService.kickMemberByUserId(guild.id, ownUserId).subscribe({
      next: () => {
        this.guilds.update(gs => gs.filter(g => g.id !== guild.id));
        const ws = this.navService.workspace();
        if (ws.type === 'server' && ws.guild.id === guild.id) {
          this.navService.selectDMs();
        }
      },
    });
  }
}
