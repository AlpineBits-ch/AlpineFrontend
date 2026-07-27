import {Component, inject, input, OnInit, signal} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Dialog} from 'primeng/dialog';
import {GuildDto} from '../../../../../../dtos/response/guild.dto';
import {BanDto} from '../../../../../../dtos/response/ban.dto';
import {ProfileDto} from '../../../../../../dtos/response/profile.dto';
import {GuildService} from '../../../../../../services/guild.service';
import {ProfileService} from '../../../../../../services/profile.service';
import {ToastService} from '../../../../../../services/toast.service';
import {TranslateModule} from '@ngx-translate/core';

interface BanRow {
    ban: BanDto;
    profile: ProfileDto | null;
}

@Component({
    selector: 'app-bans-settings',
    imports: [FormsModule, Button, InputText, Dialog, TranslateModule],
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
    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);
    private toastService = inject(ToastService);

    ngOnInit(): void {
        this.load();
    }

    load(): void {
        this.loading.set(true);
        this.guildService.getBans(this.guild().id).subscribe({
            next: bans => {
                const rows: BanRow[] = bans.map(ban => ({ban, profile: null}));
                this.bans.set(rows);
                this.loading.set(false);
                rows.forEach((row, i) => {
                    this.profileService.fetchByUserId(row.ban.userId).subscribe({
                        next: p => this.bans.update(list => {
                            const next = [...list];
                            next[i] = {...next[i], profile: p};
                            return next;
                        }),
                    });
                });
            },
            error: err => {
                this.loading.set(false);
                this.toastService.httpError('Failed to load bans', err);
            },
        });
    }

    displayName(row: BanRow): string {
        return row.profile?.userName ?? row.ban.userId.slice(0, 8) + '…';
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
                this.load();
            },
            error: err => {
                this.banning.set(false);
                this.toastService.httpError('Failed to ban user', err);
            },
        });
    }

    unban(row: BanRow): void {
        if (this.unbanningId()) return;
        this.unbanningId.set(row.ban.id);
        this.guildService.unbanMember(this.guild().id, row.ban.userId).subscribe({
            next: () => {
                this.bans.update(list => list.filter(r => r.ban.id !== row.ban.id));
                this.unbanningId.set(null);
            },
            error: err => {
                this.unbanningId.set(null);
                this.toastService.httpError('Failed to unban user', err);
            },
        });
    }
}
