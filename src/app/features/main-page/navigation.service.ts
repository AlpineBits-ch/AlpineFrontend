import { Injectable, signal } from '@angular/core';
import { ConversationDto } from '../../dtos/response/conversation.dto';
import { ChannelDto, ChannelType, GuildDto } from '../../dtos/response/guild.dto';

export type WorkspaceContext =
  | { type: 'dms' }
  | { type: 'server'; guild: GuildDto };

export type MainView =
  | { type: 'home' }
  | { type: 'conversation'; conversation: ConversationDto }
  | { type: 'channel'; channel: ChannelDto }
  | { type: 'wiki'; guildId: string };

@Injectable({ providedIn: 'root' })
export class NavigationService {
  readonly workspace = signal<WorkspaceContext>({ type: 'dms' });
  readonly mainView = signal<MainView>({ type: 'home' });
  readonly mobileNavOpen = signal(false);
  readonly mobileSection = signal<'conversations' | 'friends'>('conversations');
  readonly wikiPanelGuildId = signal<string | null>(null);

  selectDMs(): void {
    this.workspace.set({ type: 'dms' });
    this.mainView.set({ type: 'home' });
    this.mobileSection.set('conversations');
    this.wikiPanelGuildId.set(null);
  }

  selectServer(guild: GuildDto): void {
    const current = this.workspace();
    if (current.type === 'server' && current.guild.id === guild.id) return;
    this.workspace.set({ type: 'server', guild });
    this.wikiPanelGuildId.set(null);
    const first = guild.channels.find(c => c.type === ChannelType.Text) ?? guild.channels[0];
    if (first) this.mainView.set({ type: 'channel', channel: first });
  }

  updateCurrentGuild(guild: GuildDto): void {
    const current = this.workspace();
    if (current.type === 'server' && current.guild.id === guild.id) {
      this.workspace.set({ type: 'server', guild });
    }
  }

  showHome(): void {
    this.mainView.set({ type: 'home' });
    this.mobileSection.set('conversations');
  }

  showFriends(): void {
    this.mainView.set({ type: 'home' });
    this.mobileSection.set('friends');
    this.mobileNavOpen.set(false);
  }

  openConversation(conversation: ConversationDto): void {
    this.workspace.set({ type: 'dms' });
    this.mainView.set({ type: 'conversation', conversation });
    this.mobileNavOpen.set(false);
  }

  openChannel(channel: ChannelDto): void {
    this.mainView.set({ type: 'channel', channel });
    this.mobileNavOpen.set(false);
  }

  openWiki(guildId: string): void {
    this.wikiPanelGuildId.set(guildId);
    this.mobileNavOpen.set(false);
  }

  showWikiContent(guildId: string): void {
    this.mainView.set({ type: 'wiki', guildId });
  }

  closeWikiPanel(): void {
    this.wikiPanelGuildId.set(null);
    if (this.mainView().type === 'wiki') {
      const ws = this.workspace();
      if (ws.type === 'server') {
        const first = ws.guild.channels.find(c => c.type === ChannelType.Text) ?? ws.guild.channels[0];
        if (first) this.mainView.set({ type: 'channel', channel: first });
        else this.mainView.set({ type: 'home' });
      } else {
        this.mainView.set({ type: 'home' });
      }
    }
  }
}
