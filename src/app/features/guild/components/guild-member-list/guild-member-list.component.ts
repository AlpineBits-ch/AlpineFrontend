import { Component, computed, inject, input, OnChanges, signal, SimpleChanges } from '@angular/core';
import { GuildDto } from '../../../../dtos/response/guild.dto';
import { GuildMemberDto } from '../../../../dtos/response/member.dto';
import { OnlineStatus, ProfileDto } from '../../../../dtos/response/profile.dto';
import { GuildService } from '../../../../services/guild.service';
import { ProfileService } from '../../../../services/profile.service';

interface MemberRow {
  member: GuildMemberDto;
  profile: ProfileDto | null;
}

@Component({
  selector: 'app-guild-member-list',
  templateUrl: './guild-member-list.component.html',
})
export class GuildMemberListComponent implements OnChanges {
  guild = input.required<GuildDto>();

  private guildService = inject(GuildService);
  private profileService = inject(ProfileService);

  private readonly TAKE = 50;
  private nextSkip = 0;

  rows = signal<MemberRow[]>([]);
  loading = signal(true);
  loadingMore = signal(false);
  hasMore = signal(true);

  onlineRows = computed(() => this.rows().filter(r => r.profile?.onlineStatus === OnlineStatus.Online));
  offlineRows = computed(() => this.rows().filter(r => !r.profile || r.profile.onlineStatus === OnlineStatus.Offline));

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
        const baseIdx = skip === 0 ? 0 : this.rows().length;
        const newRows: MemberRow[] = incoming.map(m => ({ member: m, profile: null }));

        if (skip === 0) {
          this.rows.set(newRows);
          this.loading.set(false);
        } else {
          this.rows.update(list => [...list, ...newRows]);
          this.loadingMore.set(false);
        }

        this.nextSkip = skip + incoming.length;
        if (incoming.length < this.TAKE) this.hasMore.set(false);

        newRows.forEach((row, i) => {
          this.profileService.getByUserId(row.member.userId).subscribe({
            next: p => {
              if (this.guild().id !== guildId) return;
              this.rows.update(list => {
                const next = [...list];
                const idx = baseIdx + i;
                if (next[idx]) next[idx] = { ...next[idx], profile: p };
                return next;
              });
            },
          });
        });
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

  displayName(row: MemberRow): string {
    return row.profile?.userName ?? row.member.userId.slice(0, 8) + '…';
  }
}
