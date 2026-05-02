import { Component, effect, inject, input, model, output, signal, untracked } from '@angular/core';
import { NgClass } from '@angular/common';
import { Dialog } from 'primeng/dialog';
import { Button } from 'primeng/button';
import { GuildDto, GuildMemberDto, InviteDto, RoleDto } from '../../../dtos/response/guild.dto';
import { GuildService } from '../../../services/guild.service';
import { OverviewSettingsComponent } from './pages/overview/overview-settings.component';
import { RolesSettingsComponent } from './pages/roles/roles-settings.component';
import { MembersSettingsComponent } from './pages/members/members-settings.component';
import { InvitesSettingsComponent } from './pages/invites/invites-settings.component';
import { BansSettingsComponent } from './pages/bans/bans-settings.component';

interface GuildSettingsNavItem { id: string; label: string; icon: string; }
interface GuildSettingsNavGroup { title: string; items: GuildSettingsNavItem[]; }

@Component({
  selector: 'app-guild-settings-modal',
  imports: [
    NgClass, Dialog, Button,
    OverviewSettingsComponent, RolesSettingsComponent, MembersSettingsComponent,
    InvitesSettingsComponent, BansSettingsComponent,
  ],
  templateUrl: './guild-settings-modal.component.html',
  styleUrl: './guild-settings-modal.component.css',
})
export class GuildSettingsModalComponent {
  readonly isVisible = model.required<boolean>();
  readonly guild = input.required<GuildDto>();
  readonly guildUpdated = output<GuildDto>();

  private guildService = inject(GuildService);

  protected activePage = signal('overview');
  protected members = signal<GuildMemberDto[]>([]);
  protected invites = signal<InviteDto[]>([]);
  protected roles = signal<RoleDto[]>([]);
  protected loadingMembers = signal(false);

  constructor() {
    effect(() => {
      if (this.isVisible()) {
        untracked(() => {
          this.roles.set(this.guild().roles);
          this.loadMembers();
          this.loadInvites();
        });
      }
    });
  }

  private loadMembers(): void {
    this.loadingMembers.set(true);
    this.guildService.getMembers(this.guild().id).subscribe({
      next: members => {
        this.members.set(members);
        this.loadingMembers.set(false);
      },
      error: () => this.loadingMembers.set(false),
    });
  }

  private loadInvites(): void {
    this.guildService.getInvites(this.guild().id).subscribe({
      next: invites => this.invites.set(invites),
      error: () => {},
    });
  }

  protected onGuildUpdated(guild: GuildDto): void {
    this.guildUpdated.emit(guild);
  }

  protected onRolesChanged(roles: RoleDto[]): void {
    this.roles.set(roles);
  }

  protected onMembersChanged(members: GuildMemberDto[]): void {
    this.members.set(members);
  }

  protected onInvitesChanged(invites: InviteDto[]): void {
    this.invites.set(invites);
  }

  protected navItemClasses(id: string): Record<string, boolean> {
    const active = this.activePage() === id;
    return {
      'bg-indigo-500/15 text-indigo-400': active,
      'text-white/50 hover:bg-white/[0.04] hover:text-white/75': !active,
    };
  }

  protected readonly navGroups: GuildSettingsNavGroup[] = [
    {
      title: 'Server',
      items: [
        { id: 'overview', label: 'Overview', icon: 'pi pi-server' },
        { id: 'roles',    label: 'Roles',    icon: 'pi pi-tag'    },
      ],
    },
    {
      title: 'Management',
      items: [
        { id: 'members', label: 'Members', icon: 'pi pi-users'  },
        { id: 'invites', label: 'Invites', icon: 'pi pi-link'   },
        { id: 'bans',    label: 'Bans',    icon: 'pi pi-ban'    },
      ],
    },
  ];
}
