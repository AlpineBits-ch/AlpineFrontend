import {Component, inject, input, OnInit, signal} from '@angular/core';
import {DatePipe, NgClass} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Tooltip} from 'primeng/tooltip';
import {Dialog} from 'primeng/dialog';
import {PrimeTemplate} from 'primeng/api';
import {GuildDto} from '../../../../../../dtos/response/guild.dto';
import {GuildService} from '../../../../../../services/guild.service';
import {ToastService} from '../../../../../../services/toast.service';
import {InviteDto, InviteState, InviteType} from "../../../../../../dtos/response/invite.dto";
import {TranslateModule, TranslateService} from '@ngx-translate/core';

@Component({
    selector: 'app-invites-settings',
    imports: [NgClass, Button, InputText, Tooltip, Dialog, PrimeTemplate, TranslateModule, DatePipe, FormsModule],
    templateUrl: './invites-settings.component.html',
})
export class InvitesSettingsComponent implements OnInit {
    guild = input.required<GuildDto>();
    invites = signal<InviteDto[]>([]);
    loading = signal(true);
    /** Tracked per type so pressing one button doesn't spin the other. */
    creatingType = signal<InviteType | null>(null);
    deletingId = signal<string | null>(null);
    copiedId = signal<string | null>(null);
    createExpiryHours = signal<number | null>(null);
    confirmRevokeInvite = signal<InviteDto | null>(null);
    showRevokeDialog = signal(false);
    protected InviteType = InviteType;
    protected InviteState = InviteState;
    private guildService = inject(GuildService);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);

    ngOnInit(): void {
        this.load();
    }

    load(): void {
        this.loading.set(true);
        this.guildService.getInvites(this.guild().id).subscribe({
            next: list => {
                this.invites.set(list);
                this.loading.set(false);
            },
            error: err => {
                this.loading.set(false);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.INVITES.LOAD_ERROR'), err);
            },
        });
    }

    createPermanentInvite(): void {
        this.createInvite(InviteType.Permanent);
    }

    createOneTimeInvite(): void {
        this.createInvite(InviteType.OneTime);
    }

    openRevokeDialog(invite: InviteDto): void {
        this.confirmRevokeInvite.set(invite);
        this.showRevokeDialog.set(true);
    }

    closeRevokeDialog(): void {
        this.confirmRevokeInvite.set(null);
        this.showRevokeDialog.set(false);
    }

    revokeInvite(invite: InviteDto): void {
        if (this.deletingId()) return;
        this.deletingId.set(invite.id);
        this.guildService.deleteInvite(invite.id).subscribe({
            next: () => {
                this.invites.update(list => list.filter(i => i.id !== invite.id));
                this.deletingId.set(null);
                this.closeRevokeDialog();
            },
            error: err => {
                this.deletingId.set(null);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.INVITES.REVOKE_ERROR'), err);
            },
        });
    }

    copyInvite(invite: InviteDto): void {
        const link = this.inviteLink(invite);
        navigator.clipboard.writeText(link).then(
            () => {
                this.copiedId.set(invite.id);
                setTimeout(() => this.copiedId.set(null), 2000);
            },
            // Clipboard writes are refused in insecure contexts and when permission is
            // denied; without this the button just sat there looking broken.
            () => this.toastService.error(this.translate.instant('GUILD_SETTINGS.INVITES.COPY_ERROR')),
        );
    }

    inviteLink(invite: InviteDto): string {
        return `https://venta.gg/invite/${invite.code}`;
    }

    formatDate(d: Date): string {
        return new Date(d).toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'});
    }

    private createInvite(type: InviteType): void {
        if (this.creatingType()) return;
        this.creatingType.set(type);
        const hours = this.createExpiryHours();
        // `> 0` rather than a truthiness check: 0 used to fall through to "never expires",
        // quietly creating a permanent link for someone who asked for the shortest one.
        const expiresAt = hours !== null && hours > 0
            ? new Date(Date.now() + hours * 3600_000).toISOString()
            : undefined;
        this.guildService.createInvite({type, expiresAt}, this.guild().id).subscribe({
            next: invite => {
                this.invites.update(list => [invite, ...list]);
                this.creatingType.set(null);
            },
            error: err => {
                this.creatingType.set(null);
                this.toastService.httpError(this.translate.instant('GUILD_SETTINGS.INVITES.CREATE_ERROR'), err);
            },
        });
    }
}
