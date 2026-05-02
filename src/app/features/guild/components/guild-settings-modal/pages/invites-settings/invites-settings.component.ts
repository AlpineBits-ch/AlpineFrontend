import {Component, inject, input, OnInit, signal} from '@angular/core';
import {NgClass} from '@angular/common';
import {Button} from 'primeng/button';
import {Tooltip} from 'primeng/tooltip';
import {GuildDto, InviteDto, InviteState, InviteType} from '../../../../../../dtos/response/guild.dto';
import {GuildService} from '../../../../../../services/guild.service';

@Component({
  selector: 'app-invites-settings',
  imports: [NgClass, Button, Tooltip],
  templateUrl: './invites-settings.component.html',
})
export class InvitesSettingsComponent implements OnInit {
  guild = input.required<GuildDto>();

  private guildService = inject(GuildService);

  invites = signal<InviteDto[]>([]);
  loading = signal(true);
  creating = signal(false);
  deletingId = signal<string | null>(null);
  copiedId = signal<string | null>(null);

  protected readonly InviteType = InviteType;
  protected readonly InviteState = InviteState;

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

  private createInvite(type: InviteType): void {
    if (this.creating()) return;
    this.creating.set(true);
    this.guildService.createInvite({guildId: this.guild().id, type}).subscribe({
      next: invite => {
        this.invites.update(list => [invite, ...list]);
        this.creating.set(false);
      },
      error: () => this.creating.set(false),
    });
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
    return `${window.location.origin}/invite/${invite.id}`;
  }

  formatDate(d: Date): string {
    return new Date(d).toLocaleDateString(undefined, {month: 'short', day: 'numeric', year: 'numeric'});
  }
}
