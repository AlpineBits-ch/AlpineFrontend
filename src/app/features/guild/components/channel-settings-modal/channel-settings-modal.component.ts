import {Component, computed, inject, model, output, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {Dialog} from 'primeng/dialog';
import {Button} from 'primeng/button';
import {ChannelDto, GuildDto, isForumLike} from '../../../../dtos/response/guild.dto';
import {ChannelOverviewComponent} from './pages/channel-overview/channel-overview.component';
import {ChannelPermissionsComponent} from './pages/channel-permissions/channel-permissions.component';
import {ChannelEncryptionComponent} from './pages/channel-encryption/channel-encryption.component';
import {ForumSettingsComponent} from './pages/forum-settings/forum-settings.component';
import {GuildService} from '../../../../services/guild.service';
import {PrimeTemplate} from "primeng/api";
import {TranslateModule} from '@ngx-translate/core';

interface NavItem {
    id: string;
    label: string;
    icon: string;
}

@Component({
    selector: 'app-channel-settings-modal',
    imports: [NgClass, Dialog, Button, ChannelOverviewComponent, ChannelPermissionsComponent, ChannelEncryptionComponent, ForumSettingsComponent, PrimeTemplate, TranslateModule],
    templateUrl: './channel-settings-modal.component.html',
})
export class ChannelSettingsModalComponent {
    readonly isVisible = model.required<boolean>();

    readonly channel = signal<ChannelDto | null>(null);
    readonly guild = signal<GuildDto | null>(null);

    channelUpdated = output<ChannelDto>();
    channelDeleted = output<string>();
    readonly activePage = signal('overview');
    readonly deleting = signal(false);
    readonly confirmDelete = signal(false);
    /** Tags and forum config only exist for Forum/Media channels, so that tab is conditional. */
    readonly navItems = computed<NavItem[]>(() => {
        const items: NavItem[] = [
            {id: 'overview', label: 'CHANNEL_SETTINGS.NAV.OVERVIEW', icon: 'pi pi-sliders-h'},
            {id: 'permissions', label: 'CHANNEL_SETTINGS.NAV.PERMISSIONS', icon: 'pi pi-lock'},
            {id: 'encryption', label: 'CHANNEL_SETTINGS.NAV.ENCRYPTION', icon: 'pi pi-shield'},
        ];
        const channel = this.channel();
        if (channel && isForumLike(channel.type)) {
            items.splice(1, 0, {id: 'forum', label: 'CHANNEL_SETTINGS.NAV.FORUM', icon: 'pi pi-tags'});
        }
        return items;
    });
    private guildService = inject(GuildService);

    open(channel: ChannelDto, guild: GuildDto): void {
        this.channel.set(channel);
        this.guild.set(guild);
        this.activePage.set('overview');
        this.isVisible.set(true);
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
        return this.navItems().find(i => i.id === this.activePage())?.label ?? '';
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
