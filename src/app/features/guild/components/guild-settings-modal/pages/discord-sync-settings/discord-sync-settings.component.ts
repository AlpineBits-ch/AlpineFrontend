import {Component, computed, inject, input, OnInit, signal} from '@angular/core';
import {Button} from 'primeng/button';
import {Dialog} from 'primeng/dialog';
import {PrimeTemplate} from 'primeng/api';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {GuildDto} from '../../../../../../dtos/response/guild.dto';
import {GuildLinkDto} from '../../../../../../dtos/response/discord-import.dto';
import {DiscordImportService} from '../../../../../../services/discord-import.service';
import {ExternalLinkService} from '../../../../../../services/external-link.service';
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
    startingImport = signal(false);
    showUnlinkDialog = signal(false);
    unlinkTarget = signal<GuildLinkDto | null>(null);

    /** Ids with a request in flight. A set rather than one id because the buttons are scoped
     * per row now - they used to disable every row in the list while any one of them worked. */
    private busy = signal<ReadonlySet<string>>(new Set());

    private discordImportService = inject(DiscordImportService);
    private externalLinkService = inject(ExternalLinkService);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);

    /** Null when there is no name to show - the links API doesn't return one today, which is why
     * the confirmation keeps a generic wording to fall back to instead of naming an empty string. */
    unlinkTargetName = computed(() => this.unlinkTarget()?.discordGuildName?.trim() || null);

    unlinkBusy = computed(() => {
        const target = this.unlinkTarget();
        return target !== null && this.busy().has(target.id);
    });

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

    isBusy(linkId: string): boolean {
        return this.busy().has(linkId);
    }

    /** Discord linking only happens through the import flow, which builds its own server from
     * the Discord structure - there is no route that attaches Discord to an existing server.
     * The page still offers the flow, because ending on "this server wasn't imported" and no
     * way forward is worse. The copy next to the button explains what it actually does. */
    startImport(): void {
        if (this.startingImport()) return;
        this.startingImport.set(true);
        this.discordImportService.startImport().subscribe({
            next: res => {
                this.startingImport.set(false);
                void this.externalLinkService.openExternalLink(res.authorizeUrl);
            },
            error: err => {
                this.startingImport.set(false);
                this.toastService.httpError(this.translate.instant('CREATE_GUILD.IMPORT_ERROR_TOAST'), err);
            },
        });
    }

    togglePause(link: GuildLinkDto): void {
        if (this.isBusy(link.id)) return;
        const next = link.status === 'Active' ? 'Paused' : 'Active';
        this.setBusy(link.id, true);
        this.discordImportService.setLinkStatus(link.id, next).subscribe({
            next: () => {
                // The PATCH answers 204 with an empty body whatever the typed Observable says,
                // so the row has to be patched from what we sent - reading an `id` off the
                // response threw and left the row stuck mid-request.
                this.links.update(ls => ls.map(l => l.id === link.id ? {...l, status: next} : l));
                this.setBusy(link.id, false);
                this.toastService.success(this.translate.instant(next === 'Paused'
                    ? 'GUILD_SETTINGS.DISCORD_SYNC.PAUSE_SUCCESS'
                    : 'GUILD_SETTINGS.DISCORD_SYNC.RESUME_SUCCESS'));
            },
            error: err => {
                this.setBusy(link.id, false);
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
        if (!link || this.isBusy(link.id)) return;
        this.setBusy(link.id, true);
        this.discordImportService.unlink(link.id).subscribe({
            next: () => {
                this.links.update(ls => ls.filter(l => l.id !== link.id));
                this.setBusy(link.id, false);
                this.showUnlinkDialog.set(false);
                this.unlinkTarget.set(null);
                this.toastService.success(this.translate.instant('GUILD_SETTINGS.DISCORD_SYNC.UNLINK_SUCCESS'));
            },
            error: err => {
                this.setBusy(link.id, false);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.DISCORD_SYNC.UNLINK_ERROR'), err);
            },
        });
    }

    /** A revoked link is already dead, but the API keeps handing it back, so the row used to sit
     * in the list with both its buttons hidden and no way out. Unlink is idempotent on a revoked
     * link (it re-revokes and retries removing the bot from Discord), so it doubles as the way to
     * clear the row. The server keeps its record, so this only holds until the page reloads. */
    removeRevoked(link: GuildLinkDto): void {
        if (this.isBusy(link.id)) return;
        this.setBusy(link.id, true);
        this.discordImportService.unlink(link.id).subscribe({
            next: () => {
                this.links.update(ls => ls.filter(l => l.id !== link.id));
                this.setBusy(link.id, false);
                this.toastService.success(this.translate.instant('GUILD_SETTINGS.DISCORD_SYNC.REMOVE_SUCCESS'));
            },
            error: err => {
                this.setBusy(link.id, false);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.DISCORD_SYNC.REMOVE_ERROR'), err);
            },
        });
    }

    private setBusy(linkId: string, busy: boolean): void {
        this.busy.update(ids => {
            const next = new Set(ids);
            if (busy) {
                next.add(linkId);
            } else {
                next.delete(linkId);
            }
            return next;
        });
    }
}
