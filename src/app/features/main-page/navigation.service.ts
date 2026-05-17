import {Injectable, signal} from '@angular/core';
import {ConversationDto} from '../../dtos/response/conversation.dto';
import {ChannelDto, ChannelType, GuildDto} from '../../dtos/response/guild.dto';

export type WorkspaceContext =
    | { type: 'dms' }
    | { type: 'server'; guild: GuildDto };

export type MainView =
    | { type: 'home' }
    | { type: 'conversation'; conversation: ConversationDto }
    | { type: 'channel'; channel: ChannelDto }
    | { type: 'wiki'; guildId: string };

interface PersistedNav {
    kind: 'dms-home' | 'dms-conversation' | 'server-channel' | 'server-wiki';
    guildId?: string;
    channelId?: string;
    conversationId?: string;
}

const NAV_KEY = 'alpine_nav';

@Injectable({providedIn: 'root'})
export class NavigationService {
    readonly workspace = signal<WorkspaceContext>({type: 'dms'});
    readonly mainView = signal<MainView>({type: 'home'});
    readonly mobileNavOpen = signal(false);
    readonly mobileSection = signal<'conversations' | 'friends'>('conversations');
    readonly wikiPanelGuildId = signal<string | null>(null);

    tryRestoreGuildNav(guilds: GuildDto[]): boolean {
        try {
            const raw = localStorage.getItem(NAV_KEY);
            if (!raw) return false;
            const state = JSON.parse(raw) as PersistedNav;
            if (state.kind !== 'server-channel' && state.kind !== 'server-wiki') return false;
            const guild = guilds.find(g => g.id === state.guildId);
            if (!guild) return false;
            this.workspace.set({type: 'server', guild});
            this.wikiPanelGuildId.set(null);
            if (state.kind === 'server-wiki') {
                this.mainView.set({type: 'wiki', guildId: guild.id});
            } else {
                const ch = guild.channels.find(c => c.id === state.channelId)
                    ?? guild.channels.find(c => c.type === ChannelType.Text)
                    ?? guild.channels[0];
                if (ch) this.mainView.set({type: 'channel', channel: ch});
            }
            return true;
        } catch {
            return false;
        }
    }

    tryRestoreConversationNav(conversations: ConversationDto[]): boolean {
        try {
            const raw = localStorage.getItem(NAV_KEY);
            if (!raw) return false;
            const state = JSON.parse(raw) as PersistedNav;
            if (state.kind !== 'dms-conversation' || !state.conversationId) return false;
            const conv = conversations.find(c => c.id === state.conversationId);
            if (!conv) return false;
            this.workspace.set({type: 'dms'});
            this.mainView.set({type: 'conversation', conversation: conv});
            return true;
        } catch {
            return false;
        }
    }

    selectDMs(): void {
        this.workspace.set({type: 'dms'});
        this.mainView.set({type: 'home'});
        this.mobileSection.set('conversations');
        this.wikiPanelGuildId.set(null);
        this.saveNav();
    }

    selectServer(guild: GuildDto): void {
        const current = this.workspace();
        if (current.type === 'server' && current.guild.id === guild.id) return;
        this.workspace.set({type: 'server', guild});
        this.wikiPanelGuildId.set(null);
        const first = guild.channels.find(c => c.type === ChannelType.Text) ?? guild.channels[0];
        if (first) this.mainView.set({type: 'channel', channel: first});
        this.saveNav();
    }

    updateCurrentGuild(guild: GuildDto): void {
        const current = this.workspace();
        if (current.type === 'server' && current.guild.id === guild.id) {
            this.workspace.set({type: 'server', guild});
        }
    }

    showHome(): void {
        this.mainView.set({type: 'home'});
        this.mobileSection.set('conversations');
        this.saveNav();
    }

    showFriends(): void {
        this.mainView.set({type: 'home'});
        this.mobileSection.set('friends');
        this.mobileNavOpen.set(false);
        this.saveNav();
    }

    openConversation(conversation: ConversationDto): void {
        this.workspace.set({type: 'dms'});
        this.mainView.set({type: 'conversation', conversation});
        this.mobileNavOpen.set(false);
        this.saveNav();
    }

    openChannel(channel: ChannelDto): void {
        this.mainView.set({type: 'channel', channel});
        this.mobileNavOpen.set(false);
        this.saveNav();
    }

    openWiki(guildId: string): void {
        this.wikiPanelGuildId.set(guildId);
        const current = this.mainView();
        if (current.type !== 'wiki' || current.guildId !== guildId) {
            this.mainView.set({type: 'wiki', guildId});
            this.saveNav();
        }
        this.mobileNavOpen.set(false);
    }

    showWikiContent(guildId: string): void {
        this.mainView.set({type: 'wiki', guildId});
        this.saveNav();
    }

    closeWikiPanel(): void {
        this.wikiPanelGuildId.set(null);
        if (this.mainView().type === 'wiki') {
            const ws = this.workspace();
            if (ws.type === 'server') {
                const first = ws.guild.channels.find(c => c.type === ChannelType.Text) ?? ws.guild.channels[0];
                if (first) this.mainView.set({type: 'channel', channel: first});
                else this.mainView.set({type: 'home'});
            } else {
                this.mainView.set({type: 'home'});
            }
            this.saveNav();
        }
    }

    private saveNav(): void {
        const ws = this.workspace();
        const view = this.mainView();
        let state: PersistedNav;
        if (ws.type === 'dms') {
            state = view.type === 'conversation'
                ? {kind: 'dms-conversation', conversationId: view.conversation.id}
                : {kind: 'dms-home'};
        } else {
            if (view.type === 'wiki') {
                state = {kind: 'server-wiki', guildId: ws.guild.id};
            } else if (view.type === 'channel') {
                state = {kind: 'server-channel', guildId: ws.guild.id, channelId: view.channel.id};
            } else {
                state = {kind: 'server-channel', guildId: ws.guild.id};
            }
        }
        try {
            localStorage.setItem(NAV_KEY, JSON.stringify(state));
        } catch {
        }
    }
}
