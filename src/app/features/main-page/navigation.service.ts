import {Injectable, signal} from '@angular/core';
import {ConversationDto} from '../../dtos/response/conversation.dto';
import {ChannelDto, ChannelType, GuildDto} from '../../dtos/response/guild.dto';
import {GuildFeature, guildHasFeature} from '../guild/guild-features';

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
    readonly eventsPanelGuildId = signal<string | null>(null);

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
            this.eventsPanelGuildId.set(null);
            // A guild that has since switched its Wiki module off would otherwise restore
            // straight into a wiki with no way back to it in the sidebar.
            if (state.kind === 'server-wiki' && guildHasFeature(guild, GuildFeature.Wiki)) {
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
        this.eventsPanelGuildId.set(null);
        this.saveNav();
    }

    selectServer(guild: GuildDto): void {
        const current = this.workspace();
        if (current.type === 'server' && current.guild.id === guild.id) return;
        this.workspace.set({type: 'server', guild});
        this.wikiPanelGuildId.set(null);
        this.eventsPanelGuildId.set(null);
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
        // A forum post brings its own post-list pane, which lives in the same slot as the
        // wiki and events panels - see main-page.component.html. Opening one closes those
        // two, exactly as openWiki closes the events panel. Ordinary channels don't, so
        // browsing text channels with the wiki panel open still works.
        //
        // This keys on Thread rather than on forumParentOf: openChannel has no channel list
        // to resolve the parent against, and a non-forum thread closing those panels is
        // harmless.
        if (channel.type === ChannelType.Thread) {
            this.wikiPanelGuildId.set(null);
            this.eventsPanelGuildId.set(null);
        }
        this.mainView.set({type: 'channel', channel});
        this.mobileNavOpen.set(false);
        this.saveNav();
    }

    /** True when the given channel is the one currently shown in the main view. */
    isChannelActive(channelId: string): boolean {
        const view = this.mainView();
        return view.type === 'channel' && view.channel.id === channelId;
    }

    openWiki(guildId: string): void {
        this.wikiPanelGuildId.set(guildId);
        // Both panels render in the same slot of main-page.component.html, so leaving the
        // other one open produces a double sidebar. They are mutually exclusive.
        this.eventsPanelGuildId.set(null);
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

    /** Pure toggle -unlike the wiki panel, events have no dedicated main-view route, so opening/closing both go through the same header button. */
    toggleEventsPanel(guildId: string): void {
        const next = this.eventsPanelGuildId() === guildId ? null : guildId;
        this.eventsPanelGuildId.set(next);
        // Mutually exclusive with the wiki panel -they share the same layout slot.
        if (next) this.wikiPanelGuildId.set(null);
    }

    closeEventsPanel(): void {
        this.eventsPanelGuildId.set(null);
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
