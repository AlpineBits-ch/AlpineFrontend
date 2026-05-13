import { Component, computed, inject, input, OnChanges, signal, SimpleChanges } from '@angular/core';
import { GuildDto } from '../../../../dtos/response/guild.dto';
import { GuildMemberDto } from '../../../../dtos/response/member.dto';
import { OnlineStatus } from '../../../../dtos/response/profile.dto';
import { GuildService } from '../../../../services/guild.service';
import { environment } from '../../../../../environments/environment';
import { TranslateModule } from '@ngx-translate/core';

@Component({
  selector: 'app-guild-member-list',
  imports: [TranslateModule],
  templateUrl: './guild-member-list.component.html',
})
export class GuildMemberListComponent implements OnChanges {
  guild = input.required<GuildDto>();

  private guildService = inject(GuildService);

  private readonly TAKE = 50;
  private nextSkip = 0;

  rows = signal<GuildMemberDto[]>([]);
  loading = signal(true);
  loadingMore = signal(false);
  hasMore = signal(true);

  onlineRows = computed(() => this.rows().filter(m => m.status === OnlineStatus.Online));
  offlineRows = computed(() => this.rows().filter(m => m.status !== OnlineStatus.Online));

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['guild']) {
      this.reset();
      this.fetchPage(this.guild().id);
    }
  }

  private reset(): void {
    this.rows.set([]);
    this.nextSkip = 0;
    this.hasMore.set(true);
    this.loading.set(true);
    this.loadingMore.set(false);
  }

  private fetchPage(guildId: string): void {
    const skip = this.nextSkip;
    this.guildService.getMembers(guildId, skip, this.TAKE).subscribe({
      next: incoming => {
        if (this.guild().id !== guildId) return;

        if (skip === 0) {
          this.rows.set(incoming);
          this.loading.set(false);
        } else {
          this.rows.update(list => [...list, ...incoming]);
          this.loadingMore.set(false);
        }

        this.nextSkip = skip + incoming.length;
        if (incoming.length < this.TAKE) this.hasMore.set(false);
      },
      error: () => {
        this.loading.set(false);
        this.loadingMore.set(false);
      },
    });
  }

  loadMore(): void {
    if (this.loadingMore() || !this.hasMore() || this.loading()) return;
    this.loadingMore.set(true);
    this.fetchPage(this.guild().id);
  }

  onScroll(event: Event): void {
    const el = event.target as HTMLElement;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 150) {
      this.loadMore();
    }
  }

  displayName(member: GuildMemberDto): string {
    return member.profile?.userName ?? member.userId.slice(0, 8) + '…';
  }

  avatarUrl(member: GuildMemberDto): string | undefined {
    if (!member.profile) return undefined;
    return `${environment.apiUrl}/api/v1/social/profiles/${member.profile.id}/avatar`;
  }
}
