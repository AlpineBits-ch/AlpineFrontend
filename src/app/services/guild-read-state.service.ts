import {inject, Injectable, signal} from '@angular/core';
import {GuildWebsocketService} from './guild-websocket.service';
import {NavigationService} from '../features/main-page/navigation.service';
import {GuildService} from './guild.service';
import {ProfileService} from './profile.service';

export interface ChannelReadState {
  isUnread: boolean;
  mentionCount: number;
}

@Injectable({providedIn: 'root'})
export class GuildReadStateService {
  private guildWs = inject(GuildWebsocketService);
  private navService = inject(NavigationService);
  private guildService = inject(GuildService);
  private profileService = inject(ProfileService);

  private loadedGuildIds = new Set<string>();
  private _channelStates = signal<Record<string, ChannelReadState>>({});
  readonly channelStates = this._channelStates.asReadonly();

  constructor() {
    this.guildWs.messageObservable.subscribe(msg => {
      if (!msg.channelId) return;
      const view = this.navService.mainView();
      const isActive = view.type === 'channel' && view.channel.id === msg.channelId;
      if (!isActive) {
        const ownId = this.profileService.ownProfile()?.userId;
        const mentionIncrement = ownId && (msg.mentions ?? []).includes(ownId) ? 1 : 0;
        this._markUnread(msg.channelId, mentionIncrement);
      }
    });
  }

  loadForGuild(guildId: string): void {
    if (this.loadedGuildIds.has(guildId)) return;
    this.loadedGuildIds.add(guildId);

    this.guildService.getOwnMember(guildId).subscribe({
      next: member => {
        const filtered = (member.readState ?? []).filter(rs => rs.memberId === member.id);
        this._channelStates.update(states => {
          const next = {...states};
          for (const rs of filtered) {
            if (!next[rs.channelId]) {
              next[rs.channelId] = {
                isUnread: rs.mentionCount > 0,
                mentionCount: rs.mentionCount,
              };
            }
          }
          return next;
        });
      },
      error: () => {},
    });
  }

  markChannelRead(channelId: string): void {
    this._channelStates.update(s => ({...s, [channelId]: {isUnread: false, mentionCount: 0}}));
  }

  private _markUnread(channelId: string, mentionIncrement: number = 0): void {
    this._channelStates.update(s => ({
      ...s,
      [channelId]: {
        isUnread: true,
        mentionCount: (s[channelId]?.mentionCount ?? 0) + mentionIncrement,
      },
    }));
  }

  getChannelState(channelId: string): ChannelReadState {
    return this._channelStates()[channelId] ?? {isUnread: false, mentionCount: 0};
  }

  hasAnyUnread(channelIds: string[]): boolean {
    const states = this._channelStates();
    return channelIds.some(id => states[id]?.isUnread ?? false);
  }
}
