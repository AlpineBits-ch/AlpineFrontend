import {inject, Injectable, signal} from '@angular/core';
import {ConversationDto} from '../../dtos/response/conversation.dto';
import {ChannelDto, ChannelType, GuildDto} from '../../dtos/response/guild.dto';
import {GuildFeature, guildHasFeature, hasHouseholdModule} from '../guild/guild-features';
import {AccountRegistryService, BOOTSTRAP_SLOT_ID} from '../../services/account-registry.service';

export type WorkspaceContext =
    | { type: 'dms' }
    | { type: 'server'; guild: GuildDto };

export type MainView =
    | { type: 'home' }
    | { type: 'conversation'; conversation: ConversationDto }
    | { type: 'channel'; channel: ChannelDto }
    | { type: 'wiki'; guildId: string }
    /** The household digest - one guild-scoped view over six modules, not a channel. */
    | { type: 'house'; guildId: string };

interface PersistedNav {
    kind: 'dms-home' | 'dms-conversation' | 'server-channel' | 'server-wiki' | 'server-house';
    guildId?: string;
    channelId?: string;
    conversationId?: string;
}

const NAV_KEY = 'alpine_nav';

/** How many places back the titlebar arrows can walk. Beyond this the oldest entry is dropped. */
const HISTORY_LIMIT = 50;

/** Where the app was, in the only two signals that decide what the main pane draws. */
interface NavSnapshot {
    workspace: WorkspaceContext;
    mainView: MainView;
}

@Injectable({providedIn: 'root'})
export class NavigationService {
    readonly workspace = signal<WorkspaceContext>({type: 'dms'});
    readonly mainView = signal<MainView>({type: 'home'});
    readonly mobileNavOpen = signal(false);
    readonly mobileSection = signal<'conversations' | 'friends'>('conversations');
    readonly eventsPanelGuildId = signal<string | null>(null);

    /**
     * Browser-style history over the signal-based navigation.
     *
     * <p>There is no router to lean on here - every move is a `set` on {@link workspace} and
     * {@link mainView} - so the stack is kept by hand. Every method that persists a navigation
     * also records one, which is why {@link saveNav} is the single place that pushes: anything
     * worth restoring across a restart is by definition worth stepping back to.</p>
     */
    private history: NavSnapshot[] = [];
    private cursor = -1;
    /** Set while {@link applySnapshot} writes, so replaying a step never records itself. */
    private replaying = false;

    private readonly accounts = inject(AccountRegistryService);

    /**
     * Where this account's last position is kept.
     *
     * <p>Per-account, because the entry names a guild, channel or conversation that only one
     * account can see: restoring another account's last position lands the user on a context they
     * are not a member of, and on the DM side names someone they may not know.</p>
     *
     * <p>Reads the loaded snapshot rather than awaiting the registry - every caller here is
     * synchronous, and the launch sequence establishes the slot before the first guild or
     * conversation list arrives. Falling back to the bootstrap key costs at most one unrestored
     * navigation, never a cross-account one.</p>
     */
    private navKey(): string {
        return `${NAV_KEY}:${this.accounts.activeSlotIdSnapshot() ?? BOOTSTRAP_SLOT_ID}`;
    }

    readonly canGoBack = signal(false);
    readonly canGoForward = signal(false);

    constructor() {
        // Seeds the stack with the launch state, so the first navigation already has somewhere
        // to go back to rather than needing two before the arrows come alive.
        this.pushHistory();
    }

    /**
     * Puts the app back where it was, given the guilds it can choose from.
     *
     * <p>Takes a `readonly` list because the one it is handed on a warm start is the cached layout
     * `GuildService` hydrated itself with, and that list is shared with every other consumer.</p>
     */
    tryRestoreGuildNav(guilds: readonly GuildDto[]): boolean {
        try {
            const raw = localStorage.getItem(this.navKey());
            if (!raw) return false;
            const state = JSON.parse(raw) as PersistedNav;
            if (state.kind !== 'server-channel' && state.kind !== 'server-wiki'
                && state.kind !== 'server-house') return false;
            const guild = guilds.find(g => g.id === state.guildId);
            if (!guild) return false;
            this.workspace.set({type: 'server', guild});
            this.eventsPanelGuildId.set(null);
            // A guild that has since switched its Wiki module off would otherwise restore
            // straight into a wiki with no way back to it in the sidebar.
            if (state.kind === 'server-wiki' && guildHasFeature(guild, GuildFeature.Wiki)) {
                this.mainView.set({type: 'wiki', guildId: guild.id});
            } else if (state.kind === 'server-house' && hasHouseholdModule(guild)) {
                this.mainView.set({type: 'house', guildId: guild.id});
            } else {
                const ch = guild.channels.find(c => c.id === state.channelId)
                    ?? guild.channels.find(c => c.type === ChannelType.Text)
                    ?? guild.channels[0];
                if (ch) this.mainView.set({type: 'channel', channel: ch});
            }
            this.pushHistory();
            return true;
        } catch {
            return false;
        }
    }

    tryRestoreConversationNav(conversations: ConversationDto[]): boolean {
        try {
            const raw = localStorage.getItem(this.navKey());
            if (!raw) return false;
            const state = JSON.parse(raw) as PersistedNav;
            if (state.kind !== 'dms-conversation' || !state.conversationId) return false;
            const conv = conversations.find(c => c.id === state.conversationId);
            if (!conv) return false;
            this.workspace.set({type: 'dms'});
            this.mainView.set({type: 'conversation', conversation: conv});
            this.pushHistory();
            return true;
        } catch {
            return false;
        }
    }

    selectDMs(): void {
        this.workspace.set({type: 'dms'});
        this.mainView.set({type: 'home'});
        this.mobileSection.set('conversations');
        this.eventsPanelGuildId.set(null);
        this.saveNav();
    }

    selectServer(guild: GuildDto): void {
        const current = this.workspace();
        if (current.type === 'server' && current.guild.id === guild.id) return;
        this.workspace.set({type: 'server', guild});
        this.eventsPanelGuildId.set(null);
        const first = guild.channels.find(c => c.type === ChannelType.Text) ?? guild.channels[0];
        if (first) this.mainView.set({type: 'channel', channel: first});
        this.saveNav();
    }

    /**
     * Re-points the open workspace at a newer object for the same guild.
     *
     * <p><b>Returns early when the object is the one already held.</b> That is not a micro
     * optimisation: `workspace` is an input to the member list, the channel list and the channel
     * view, and every one of them treats a new reference as "this is a different guild now" and
     * refetches. `GuildService` reconciles fetches so an unchanged guild keeps its identity - this
     * is the other half of that, because wrapping the same guild in a fresh `{type, guild}` object
     * would hand them a change anyway. The websocket `guildUpdated` handler refetches and calls
     * this on every event, including the ones where nothing moved.</p>
     *
     * <p>The open channel is re-pointed with it. The one in {@link mainView} came out of the
     * previous guild object, so leaving it behind shows the pre-edit name and topic until the user
     * clicks something else - visible on a warm start, where the guild it came from was the cached
     * snapshot. Unchanged channels keep their identity through the same reconciliation, so this
     * fires only when the channel on screen genuinely changed.</p>
     */
    updateCurrentGuild(guild: GuildDto): void {
        const current = this.workspace();
        if (current.type !== 'server' || current.guild.id !== guild.id) return;
        if (current.guild === guild) return;

        this.workspace.set({type: 'server', guild});

        const view = this.mainView();
        if (view.type !== 'channel') return;
        const channel = guild.channels.find(c => c.id === view.channel.id);
        // A channel that has since been deleted is left alone rather than closed: the websocket
        // channel-deleted handler owns that decision and knows what to move to.
        if (channel && channel !== view.channel) this.mainView.set({type: 'channel', channel});
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
        // events panel - see main-page.component.html. Opening one closes that panel.
        // Ordinary channels don't, so browsing text channels with it open still works.
        //
        // This keys on Thread rather than on forumParentOf: openChannel has no channel list
        // to resolve the parent against, and a non-forum thread closing that panel is
        // harmless.
        if (channel.type === ChannelType.Thread) {
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

    /**
     * The wiki is a main view and nothing else. It used to also own a side panel in the same
     * slot as the events panel, which is why this had to close that panel; it now lays out its
     * own tree internally, so the two can coexist.
     */
    openWiki(guildId: string): void {
        const current = this.mainView();
        if (current.type !== 'wiki' || current.guildId !== guildId) {
            this.mainView.set({type: 'wiki', guildId});
            this.saveNav();
        }
        this.mobileNavOpen.set(false);
    }

    /**
     * The household digest. Guild-scoped like the wiki, and for the same reason: it is one view
     * over six modules rather than the contents of any one channel, so there is no channel to
     * select and nothing in the channel list that could carry its active state.
     */
    openHouse(guildId: string): void {
        const current = this.mainView();
        if (current.type !== 'house' || current.guildId !== guildId) {
            this.mainView.set({type: 'house', guildId});
            this.saveNav();
        }
        this.mobileNavOpen.set(false);
    }

    /** The digest's counterpart to {@link leaveWiki}, for a house that turns every module off. */
    leaveHouse(): void {
        if (this.mainView().type !== 'house') return;
        this.leaveGuildView();
    }

    /**
     * Steps off the wiki and back into the guild, used when the Wiki module is switched off
     * while somebody is looking at it - otherwise they are stranded on a view whose entry point
     * has just disappeared from the sidebar.
     */
    leaveWiki(): void {
        if (this.mainView().type !== 'wiki') return;
        this.leaveGuildView();
    }

    /** Back to the guild's first channel, or the DM home when there is nowhere in the guild to go. */
    private leaveGuildView(): void {
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

    /** The events panel has no dedicated main view, so opening and closing both go through here. */
    toggleEventsPanel(guildId: string): void {
        const next = this.eventsPanelGuildId() === guildId ? null : guildId;
        this.eventsPanelGuildId.set(next);
    }

    closeEventsPanel(): void {
        this.eventsPanelGuildId.set(null);
    }

    // ── History ─────────────────────────────────────────────────────────────
    /** Steps to the previous place, if there is one. */
    back(): void {
        if (this.cursor <= 0) return;
        this.cursor--;
        this.applySnapshot(this.history[this.cursor]);
    }

    /** Steps forward again after a {@link back}, until the next navigation truncates the tail. */
    forward(): void {
        if (this.cursor >= this.history.length - 1) return;
        this.cursor++;
        this.applySnapshot(this.history[this.cursor]);
    }

    /**
     * Identity of a place, for deduplication. Two snapshots that render the same thing must not
     * both sit on the stack - reopening the channel you are already in would otherwise cost a
     * press of Back to undo.
     */
    private static keyOf(snap: NavSnapshot): string {
        const ws = snap.workspace.type === 'server' ? `g:${snap.workspace.guild.id}` : 'dms';
        const view = snap.mainView;
        switch (view.type) {
            case 'home':
                return `${ws}|home`;
            case 'conversation':
                return `${ws}|conv:${view.conversation.id}`;
            case 'channel':
                return `${ws}|chan:${view.channel.id}`;
            case 'wiki':
                return `${ws}|wiki:${view.guildId}`;
            case 'house':
                return `${ws}|house:${view.guildId}`;
        }
    }

    private pushHistory(): void {
        if (this.replaying) return;
        const snap: NavSnapshot = {workspace: this.workspace(), mainView: this.mainView()};
        const current = this.history[this.cursor];
        if (current && NavigationService.keyOf(current) === NavigationService.keyOf(snap)) {
            // Same place, possibly a fresher object for it (a guild that just got renamed).
            this.history[this.cursor] = snap;
            return;
        }
        // Navigating after stepping back abandons the forward tail, exactly like a browser.
        this.history.length = this.cursor + 1;
        this.history.push(snap);
        if (this.history.length > HISTORY_LIMIT) this.history.shift();
        this.cursor = this.history.length - 1;
        this.refreshHistoryFlags();
    }

    private applySnapshot(snap: NavSnapshot): void {
        this.replaying = true;
        try {
            this.workspace.set(snap.workspace);
            this.mainView.set(snap.mainView);
            this.eventsPanelGuildId.set(null);
            this.mobileNavOpen.set(false);
            this.saveNav();
        } finally {
            this.replaying = false;
        }
        this.refreshHistoryFlags();
    }

    private refreshHistoryFlags(): void {
        this.canGoBack.set(this.cursor > 0);
        this.canGoForward.set(this.cursor < this.history.length - 1);
    }

    private saveNav(): void {
        this.pushHistory();
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
            } else if (view.type === 'house') {
                state = {kind: 'server-house', guildId: ws.guild.id};
            } else if (view.type === 'channel') {
                state = {kind: 'server-channel', guildId: ws.guild.id, channelId: view.channel.id};
            } else {
                state = {kind: 'server-channel', guildId: ws.guild.id};
            }
        }
        try {
            localStorage.setItem(this.navKey(), JSON.stringify(state));
        } catch {
        }
    }
}
