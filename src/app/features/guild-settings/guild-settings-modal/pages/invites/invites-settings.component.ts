import { Component, inject, input, output, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Button } from 'primeng/button';
import { Tooltip } from 'primeng/tooltip';
import { GuildDto, InviteDto, InviteState, InviteType } from '../../../../../dtos/response/guild.dto';
import { GuildService } from '../../../../../services/guild.service';

@Component({
  selector: 'app-invites-settings',
  imports: [Button, DatePipe, Tooltip],
  templateUrl: './invites-settings.component.html',
})
export class InvitesSettingsComponent {
  readonly guild = input.required<GuildDto>();
  readonly invites = input.required<InviteDto[]>();
  readonly invitesChanged = output<InviteDto[]>();

  protected readonly InviteState = InviteState;
  protected readonly InviteType = InviteType;

  private guildService = inject(GuildService);
  protected creating = signal(false);
  protected copiedId = signal<string | null>(null);
  protected revokingId = signal<string | null>(null);

  protected inviteCode(id: string): string {
    return id.replace(/^[^_]+_/, '');
  }

  protected createInvite(type: InviteType): void {
    if (this.creating()) return;
    this.creating.set(true);
    this.guildService.createInvite(this.guild().id, type).subscribe({
      next: invite => {
        this.invitesChanged.emit([invite, ...this.invites()]);
        this.creating.set(false);
      },
      error: () => this.creating.set(false),
    });
  }

  protected revokeInvite(invite: InviteDto): void {
    if (this.revokingId()) return;
    this.revokingId.set(invite.id);
    this.guildService.revokeInvite(invite.id).subscribe({
      next: () => {
        this.invitesChanged.emit(this.invites().filter(i => i.id !== invite.id));
        this.revokingId.set(null);
      },
      error: () => this.revokingId.set(null),
    });
  }

  protected copyCode(invite: InviteDto): void {
    navigator.clipboard.writeText(this.inviteCode(invite.id));
    this.copiedId.set(invite.id);
    setTimeout(() => this.copiedId.set(null), 2000);
  }
}
