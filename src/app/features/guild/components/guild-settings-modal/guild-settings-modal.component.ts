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
import {BansSettingsComponent} from './pages/bans-settings/bans-settings.component';
import {AuditLogSettingsComponent} from './pages/audit-log-settings/audit-log-settings.component';
import {DiscordSyncSettingsComponent} from './pages/discord-sync-settings/discord-sync-settings.component';
import {EmojiSettingsComponent} from './pages/emoji-settings/emoji-settings.component';
import {TranslateModule} from '@ngx-translate/core';

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
        BansSettingsComponent,
        AuditLogSettingsComponent,
        DiscordSyncSettingsComponent,
        EmojiSettingsComponent,
        TranslateModule,
    ],
    templateUrl: './guild-settings-modal.component.html',
})
export class GuildSettingsModalComponent {
    isVisible = model.required<boolean>();
    guild = input.required<GuildDto>();
    guildUpdated = output<GuildDto>();
    guildDeleted = output<string>();

    activePage = signal('overview');
    headerIconFailed = signal(false);

    guildIconUrl = computed(() =>
        `${environment.apiUrl}/api/v1/guild/guilds/${this.guild().id}/icon`
    );
    navGroups: NavGroup[] = [
        {
            title: 'Server Settings',
            items: [
                {id: 'overview', label: 'Overview', icon: 'pi pi-home'},
                {id: 'members', label: 'Members', icon: 'pi pi-users'},
                {id: 'roles', label: 'Roles', icon: 'pi pi-shield'},
                {id: 'bans', label: 'Bans', icon: 'pi pi-ban'},
                {id: 'audit-log', label: 'Audit Log', icon: 'pi pi-history'},
            ],
        },
        {
            title: 'Community',
            items: [
                {id: 'invites', label: 'Invites', icon: 'pi pi-link'},
                {id: 'emojis', label: 'Emojis', icon: 'pi pi-face-smile'},
                {id: 'discord-sync', label: 'Discord Sync', icon: 'pi pi-discord'},
            ],
        },
    ];

    onHeaderIconError(): void {
        this.headerIconFailed.set(true);
    }

    navItemClasses(id: string): Record<string, boolean> {
        const active = this.activePage() === id;
        return {
            'bg-[color-mix(in_srgb,var(--color-brand)_15%,transparent)]': active,
            'text-[var(--color-brand-dim)]': active,
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
