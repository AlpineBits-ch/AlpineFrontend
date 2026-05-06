import {ChangeDetectionStrategy, Component, computed, DestroyRef, inject, input, OnInit, signal} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {GuildService} from '../../../../../../services/guild.service';
import {InviteDto, InviteState} from '../../../../../../dtos/response/invite.dto';
import {environment} from '../../../../../../../environments/environment';

type CardState = 'loading' | 'ready' | 'joining' | 'joined' | 'error';

@Component({
  selector: 'app-invite-card',
  standalone: true,
  templateUrl: './invite-card.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InviteCardComponent implements OnInit {
  private guildService = inject(GuildService);
  private destroyRef = inject(DestroyRef);

  inviteId = input.required<string>();

  invite = signal<InviteDto | null>(null);
  cardState = signal<CardState>('loading');
  iconFailed = signal(false);

  protected guildIconUrl = computed(() => {
    const id = this.invite()?.guild?.id;
    return id ? `${environment.apiUrl}/api/v1/guild/guilds/${id}/icon` : '';
  });

  protected readonly InviteState = InviteState;

  protected guildInitials = computed(() => {
    const name = this.invite()?.guild?.name ?? '';
    return name.split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() ?? '').join('');
  });

  ngOnInit(): void {
    this.guildService.getInvite(this.inviteId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: invite => {
          this.invite.set(invite);
          this.cardState.set('ready');
        },
        error: () => this.cardState.set('error'),
      });
  }

  join(): void {
    if (this.cardState() === 'joining') return;
    this.cardState.set('joining');
    this.guildService.redeemInvite(this.inviteId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.cardState.set('joined');
          this.guildService.guildJoined$.next();
        },
        error: () => this.cardState.set('ready'),
      });
  }
}
