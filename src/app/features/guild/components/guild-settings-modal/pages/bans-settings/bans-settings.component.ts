import {Component, computed, inject, input, OnInit, signal} from '@angular/core';
import {DatePipe} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Dialog} from 'primeng/dialog';
import {PrimeTemplate} from 'primeng/api';
import {GuildDto} from '../../../../../../dtos/response/guild.dto';
import {BanDto} from '../../../../../../dtos/response/ban.dto';
import {ProfileDto} from '../../../../../../dtos/response/profile.dto';
import {GuildService} from '../../../../../../services/guild.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {BrokenImageService} from '../../../../../../services/broken-image.service';
import {ToastService} from '../../../../../../services/toast.service';
import {TranslateModule, TranslateService} from '@ngx-translate/core';

interface BanRow {
    ban: BanDto;
    profile: ProfileDto | null;
}

@Component({
    selector: 'app-bans-settings',
    imports: [FormsModule, Button, InputText, Dialog, TranslateModule, PrimeTemplate, DatePipe],
    templateUrl: './bans-settings.component.html',
})
export class BansSettingsComponent implements OnInit {
    guild = input.required<GuildDto>();
    bans = signal<BanRow[]>([]);
    loading = signal(true);
    unbanningId = signal<string | null>(null);
    showBanDialog = signal(false);
    banUserId = signal('');
    banReason = signal('');
    banning = signal(false);
    filter = signal('');
    confirmUnbanRow = signal<BanRow | null>(null);
    showUnbanDialog = signal(false);

    /** The list can run long on a busy server, so it filters on name, reason and ID. */
    filteredBans = computed(() => {
        const q = this.filter().trim().toLowerCase();
        if (!q) return this.bans();
        return this.bans().filter(row =>
            this.displayName(row).toLowerCase().includes(q)
            || (row.ban.reason ?? '').toLowerCase().includes(q)
            || row.ban.userId.toLowerCase().includes(q)
        );
    });

    protected banIdValid = computed(() => this.banUserId().trim().length > 0);

    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);
    private brokenImages = inject(BrokenImageService);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);

    ngOnInit(): void {
        this.load();
    }

    load(): void {
        this.loading.set(true);
        this.guildService.getBans(this.guild().id).subscribe({
            next: bans => {
                this.bans.set(bans.map(ban => ({ban, profile: null})));
                this.loading.set(false);
                // Matched back by ban id, not list index: an unban landing mid-flight used
                // to shift the array and staple the arriving profile onto the wrong row.
                bans.forEach(ban => {
                    this.profileService.fetchByUserId(ban.userId).subscribe({
                        next: p => this.bans.update(list =>
                            list.map(r => r.ban.id === ban.id ? {...r, profile: p} : r)
                        ),
                    });
                });
            },
            error: err => {
                this.loading.set(false);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.BANS.LOAD_ERROR'), err);
            },
        });
    }

    displayName(row: BanRow): string {
        return row.profile?.userName ?? row.ban.userId.slice(0, 8) + '…';
    }

    // The API sends an avatarUrl for every profile, uploaded or not, so a URL that has already
    // failed is the only signal that this user has no avatar. See BrokenImageService.
    avatarUrl(row: BanRow): string | undefined {
        const url = row.profile?.avatarUrl;
        return this.brokenImages.isBroken(url) ? undefined : url;
    }

    onAvatarError(url: string): void {
        this.brokenImages.markBroken(url);
    }

    openBanDialog(): void {
        this.banUserId.set('');
        this.banReason.set('');
        this.showBanDialog.set(true);
    }

    submitBan(): void {
        const userId = this.banUserId().trim();
        if (!userId || this.banning()) return;
        this.banning.set(true);
        this.guildService.banMember(this.guild().id, {userId, reason: this.banReason().trim() || undefined}).subscribe({
            next: () => {
                this.showBanDialog.set(false);
                this.banning.set(false);
                this.toastService.success(this.translate.instant('GUILD_SETTINGS.BANS.BAN_SUCCESS'));
                this.load();
            },
            error: err => {
                this.banning.set(false);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.BANS.BAN_ERROR'), err);
            },
        });
    }

    openUnbanDialog(row: BanRow): void {
        this.confirmUnbanRow.set(row);
        this.showUnbanDialog.set(true);
    }

    closeUnbanDialog(): void {
        this.confirmUnbanRow.set(null);
        this.showUnbanDialog.set(false);
    }

    unban(row: BanRow): void {
        if (this.unbanningId()) return;
        this.unbanningId.set(row.ban.id);
        this.guildService.unbanMember(this.guild().id, row.ban.userId).subscribe({
            next: () => {
                this.bans.update(list => list.filter(r => r.ban.id !== row.ban.id));
                this.unbanningId.set(null);
                this.closeUnbanDialog();
            },
            error: err => {
                this.unbanningId.set(null);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.BANS.UNBAN_ERROR'), err);
            },
        });
    }
}
