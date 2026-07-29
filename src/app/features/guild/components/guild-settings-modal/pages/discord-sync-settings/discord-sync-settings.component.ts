import {Component, inject, input, OnInit, signal} from '@angular/core';
import {Button} from 'primeng/button';
import {Dialog} from 'primeng/dialog';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {GuildDto} from '../../../../../../dtos/response/guild.dto';
import {GuildLinkDto} from '../../../../../../dtos/response/discord-import.dto';
import {DiscordImportService} from '../../../../../../services/discord-import.service';
import {ToastService} from '../../../../../../services/toast.service';

@Component({
    selector: 'app-discord-sync-settings',
    imports: [Button, Dialog, PrimeTemplate, TranslateModule],
    templateUrl: './discord-sync-settings.component.html',
})
export class DiscordSyncSettingsComponent implements OnInit {
    guild = input.required<GuildDto>();

    links = signal<GuildLinkDto[]>([]);
    loading = signal(false);
    busyLinkId = signal<string | null>(null);
    showUnlinkDialog = signal(false);
    unlinkTarget = signal<GuildLinkDto | null>(null);

    private discordImportService = inject(DiscordImportService);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);

    ngOnInit(): void {
        this.loadLinks();
    }

    loadLinks(): void {
        this.loading.set(true);
        this.discordImportService.getLinks(this.guild().id).subscribe({
            next: links => {
                this.links.set(links);
                this.loading.set(false);
            },
            error: err => {
                this.loading.set(false);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.DISCORD_SYNC.LOAD_ERROR'), err);
            },
        });
    }

    togglePause(link: GuildLinkDto): void {
        if (this.busyLinkId()) return;
        const next = link.status === 'Active' ? 'Paused' : 'Active';
        this.busyLinkId.set(link.id);
        this.discordImportService.setLinkStatus(link.id, next).subscribe({
            next: updated => {
                this.links.update(ls => ls.map(l => l.id === updated.id ? updated : l));
                this.busyLinkId.set(null);
            },
            error: err => {
                this.busyLinkId.set(null);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.DISCORD_SYNC.UPDATE_ERROR'), err);
            },
        });
    }

    confirmUnlink(link: GuildLinkDto): void {
        this.unlinkTarget.set(link);
        this.showUnlinkDialog.set(true);
    }

    unlink(): void {
        const link = this.unlinkTarget();
        if (!link || this.busyLinkId()) return;
        this.busyLinkId.set(link.id);
        this.discordImportService.unlink(link.id).subscribe({
            next: () => {
                this.links.update(ls => ls.filter(l => l.id !== link.id));
                this.busyLinkId.set(null);
                this.showUnlinkDialog.set(false);
                this.unlinkTarget.set(null);
                this.toastService.success(this.translate.instant('GUILD_SETTINGS.DISCORD_SYNC.UNLINK_SUCCESS'));
            },
            error: err => {
                this.busyLinkId.set(null);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.DISCORD_SYNC.UNLINK_ERROR'), err);
            },
        });
    }
}
