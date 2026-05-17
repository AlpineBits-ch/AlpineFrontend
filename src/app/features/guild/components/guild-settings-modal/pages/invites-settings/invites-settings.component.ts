import {Component, inject, input, OnInit, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {Button} from 'primeng/button';
import {Tooltip} from 'primeng/tooltip';
import {GuildDto} from '../../../../../../dtos/response/guild.dto';
import {GuildService} from '../../../../../../services/guild.service';
import {InviteDto, InviteState, InviteType} from "../../../../../../dtos/response/invite.dto";
import {TranslateModule} from '@ngx-translate/core';

@Component({
    selector: 'app-invites-settings',
    imports: [NgClass, Button, Tooltip, TranslateModule],
    templateUrl: './invites-settings.component.html',
})
export class InvitesSettingsComponent implements OnInit {
    guild = input.required<GuildDto>();
    invites = signal<InviteDto[]>([]);
    loading = signal(true);
    creating = signal(false);
    deletingId = signal<string | null>(null);
    copiedId = signal<string | null>(null);
    protected InviteType = InviteType;
    protected InviteState = InviteState;
    private guildService = inject(GuildService);

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
            error: () => this.loading.set(false),
        });
    }

    createPermanentInvite(): void {
        this.createInvite(InviteType.Permanent);
    }

    createOneTimeInvite(): void {
        this.createInvite(InviteType.OneTime);
    }

    revokeInvite(invite: InviteDto): void {
        if (this.deletingId()) return;
        this.deletingId.set(invite.id);
        this.guildService.deleteInvite(invite.id).subscribe({
            next: () => {
                this.invites.update(list => list.filter(i => i.id !== invite.id));
                this.deletingId.set(null);
            },
            error: () => this.deletingId.set(null),
        });
    }

    copyInvite(invite: InviteDto): void {
        const link = this.inviteLink(invite);
        navigator.clipboard.writeText(link).then(() => {
            this.copiedId.set(invite.id);
            setTimeout(() => this.copiedId.set(null), 2000);
        });
    }

    inviteLink(invite: InviteDto): string {
        return `https://venta.gg/invite/${invite.id}`;
    }

    formatDate(d: Date): string {
        return new Date(d).toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'});
    }

    private createInvite(type: InviteType): void {
        if (this.creating()) return;
        this.creating.set(true);
        this.guildService.createInvite({type}, this.guild().id,).subscribe({
            next: invite => {
                this.invites.update(list => [invite, ...list]);
                this.creating.set(false);
            },
            error: () => this.creating.set(false),
        });
    }
}
