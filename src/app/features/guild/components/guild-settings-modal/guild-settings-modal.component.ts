import {Component, computed, input, model, output, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {GuildDto, RoleDto} from '../../../../dtos/response/guild.dto';
import {environment} from '../../../../../environments/environment';
import {OverviewSettingsComponent} from './pages/overview-settings/overview-settings.component';
import {MembersSettingsComponent} from './pages/members-settings/members-settings.component';
import {RolesSettingsComponent} from './pages/roles-settings/roles-settings.component';
import {InvitesSettingsComponent} from './pages/invites-settings/invites-settings.component';
import { TranslateModule } from '@ngx-translate/core';

interface NavItem {
  id: string;
  label: string;
  icon: string;
}

interface NavGroup {
  title: string;
  items: NavItem[];
}

@Component({
  selector: 'app-guild-settings-modal',
  imports: [
    NgClass,
    Dialog,
    Button,
    OverviewSettingsComponent,
    MembersSettingsComponent,
    RolesSettingsComponent,
    InvitesSettingsComponent,
    TranslateModule,
  ],
  templateUrl: './guild-settings-modal.component.html',
})
export class GuildSettingsModalComponent {
  isVisible = model.required<boolean>();
  guild = input.required<GuildDto>();
  guildUpdated = output<GuildDto>();

  activePage = signal('overview');
  headerIconFailed = signal(false);

  guildIconUrl = computed(() =>
    `${environment.apiUrl}/api/v1/guild/guilds/${this.guild().id}/icon`
  );

  onHeaderIconError(): void {
    this.headerIconFailed.set(true);
  }

  navGroups: NavGroup[] = [
    {
      title: 'Server Settings',
      items: [
        {id: 'overview', label: 'Overview', icon: 'pi pi-home'},
        {id: 'members', label: 'Members', icon: 'pi pi-users'},
        {id: 'roles', label: 'Roles', icon: 'pi pi-shield'},
      ],
    },
    {
      title: 'Community',
      items: [
        {id: 'invites', label: 'Invites', icon: 'pi pi-link'},
      ],
    },
  ];

  navItemClasses(id: string): Record<string, boolean> {
    const active = this.activePage() === id;
    return {
      'bg-indigo-500/15': active,
      'text-indigo-400': active,
      'text-white/50': !active,
    };
  }

  currentLabel(): string {
    for (const g of this.navGroups) {
      const found = g.items.find(i => i.id === this.activePage());
      if (found) return found.label;
    }
    return '';
  }

  onGuildUpdated(g: GuildDto): void {
    this.guildUpdated.emit(g);
  }

  onRolesChanged(_roles: RoleDto[]): void {
    // roles are managed locally in the page; emit updated guild if needed
  }
}
