import {computed, effect, inject, Injectable, Injector, signal, untracked} from '@angular/core';
import {ConversationDto} from '../../dtos/response/conversation.dto';
import {ConversationStore} from '../../stores/conversation.store';
import {ChannelDto, ChannelType, GuildDto} from '../../dtos/response/guild.dto';
import {GuildFeature, guildHasFeature, hasHouseholdModule} from '../guild/guild-features';
import {AccountRegistryService, BOOTSTRAP_SLOT_ID} from '../../services/account-registry.service';
import {VisitedThreadsService} from '../../services/visited-threads.service';

export type WorkspaceContext = {type: 'dms'} | {type: 'server'; guild: GuildDto};

/** Which half of the scene board is on screen. Everything to do with folders and tags is in `archive`. */
export type SceneBoardMode = 'playing' | 'archive';

export type MainView =
    | {type: 'home'}
    | {type: 'conversation'; conversation: ConversationDto}
    | {type: 'channel'; channel: ChannelDto}
    | {type: 'wiki'; guildId: string}
    /** The household digest - one guild-scoped view over six modules, not a channel. */
    | {type: 'house'; guildId: string}
    /** The guild's cast list, and the approval queue behind it. */
    | {type: 'personas'; guildId: string}
    | {type: 'character'; guildId: string; personaId: string}
    /** Every scene in the guild, ordered by what is waiting on the reader. */
    | {
          type: 'scenes';
          guildId: string;
          mode: SceneBoardMode;
          /** The shelf the board or the archive is filtered to. Null is every shelf. */
          folderId?: string | null;
          /** The scene open in the content pane. Null shows the board or the archive instead. */
          sceneChannelId?: string | null;
      };

interface PersistedNav {
    kind:
        | 'dms-home'
        | 'dms-conversation'
        | 'server-channel'
        | 'server-wiki'
        | 'server-house'
        | 'server-personas'
        | 'server-scenes';
    guildId?: string;
    channelId?: string;
    conversationId?: string;
    sceneMode?: SceneBoardMode;
    sceneFolderId?: string | null;
    sceneChannelId?: string | null;
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
    /** The thread open beside the main view. A panel, not a view: it never appears in nav history. */
    readonly threadPanel = signal<ChannelDto | null>(null);

    /**
     * The open conversation as the store holds it now. `mainView` carries the copy it was opened
     * with, so a rename or a new icon leaves every surface reading it stale until a reload.
     *
     * The store is resolved here rather than injected: injecting it would drag the realtime
     * connection, and through it OAuth, into every consumer of this service.
     */
    readonly activeConversation = computed((): ConversationDto | null => {
        const view = this.mainView();
        if (view.type !== 'conversation') return null;
        const held = this.injector.get(ConversationStore).entityMap()[view.conversation.id];
        return held ?? view.conversation;
    });

    private readonly injector = inject(Injector);

    /** Browser-style history over the signal-based navigation. */
    private history: NavSnapshot[] = [];
    private cursor = -1;
    /** Set while {@link applySnapshot} writes, so replaying a step never records itself. */
    private replaying = false;

    private readonly accounts = inject(AccountRegistryService);

    /** Where this account's last position is kept. */
    private navKey(): string {
        return `${NAV_KEY}:${this.accounts.activeSlotIdSnapshot() ?? BOOTSTRAP_SLOT_ID}`;
    }

    readonly canGoBack = signal(false);
    readonly canGoForward = signal(false);

    constructor() {
        // Seeds the stack with the launch state, so the first navigation already has somewhere
        // to go back to rather than needing two before the arrows come alive.
        this.pushHistory();

        // One place rather than one per navigation method: a panel left open over a channel it
        // does not belong to is the failure, and every path that moves the main view is a way in.
        effect(() => {
            this.mainView();
            untracked(() => this.threadPanel.set(null));
        });
    }

    openThread(thread: ChannelDto): void {
        // A scene is thread-shaped and reaches this from the same lists, but it carries a turn rail,
        // a cast and a conclusion mark that a 25rem panel cannot hold. It takes the main view.
        if (thread.type === ChannelType.Scene) {
            this.openChannel(thread);
            return;
        }

        this.threadPanel.set(thread);
        this.mobileNavOpen.set(false);
        // Resolved rather than injected, for the same reason ConversationStore is: a direct inject
        // would drag the realtime connection into every consumer of this service.
        const parentId = thread.parentChannelId;
        if (parentId) this.injector.get(VisitedThreadsService).record(parentId, thread.id);
    }

    closeThread(): void {
        this.threadPanel.set(null);
    }

    /** Puts the app back where it was, given the guilds it can choose from. */
    tryRestoreGuildNav(guilds: readonly GuildDto[]): boolean {
        try {
            const raw = localStorage.getItem(this.navKey());
            if (!raw) return false;
            const state = JSON.parse(raw) as PersistedNav;
            if (
                state.kind !== 'server-channel' &&
                state.kind !== 'server-wiki' &&
                state.kind !== 'server-house' &&
                state.kind !== 'server-personas' &&
                state.kind !== 'server-scenes'
            )
                return false;
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
            } else if (state.kind === 'server-personas' && guildHasFeature(guild, GuildFeature.Personas)) {
                this.mainView.set({type: 'personas', guildId: guild.id});
            } else if (state.kind === 'server-scenes' && guildHasFeature(guild, GuildFeature.Scenes)) {
                this.sceneMode = state.sceneMode ?? 'playing';
                this.sceneFolderId = state.sceneFolderId ?? null;
                // A scene whose channel has gone falls back to the board rather than an empty pane.
                const scene = guild.channels.find(c => c.id === state.sceneChannelId);
                this.mainView.set({
                    type: 'scenes',
                    guildId: guild.id,
                    mode: this.sceneMode,
                    folderId: this.sceneFolderId,
                    sceneChannelId: scene?.id ?? null,
                });
            } else {
                const ch =
                    guild.channels.find(c => c.id === state.channelId) ??
                    guild.channels.find(c => c.type === ChannelType.Text) ??
                    guild.channels[0];
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

    /** Re-points the open workspace at a newer object for the same guild. */
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
        // A forum post's post-list pane shares a slot with the events panel, so opening one closes
        // that panel. Keys on Thread rather than forumParentOf: openChannel has no channel list to
        // resolve the parent against.
        if (channel.type === ChannelType.Thread) {
            this.eventsPanelGuildId.set(null);
        }
        this.mainView.set({type: 'channel', channel});
        this.mobileNavOpen.set(false);
        this.saveNav();
    }

    /**
     * Opens a channel anchored at its first message rather than its last. Set just before the view
     * changes and read once by the conversation, so an ordinary reopen of the same channel later
     * lands at the present the way it always does.
     */
    openChannelFromStart(channel: ChannelDto): void {
        this.readFromStart.set(channel.id);
        this.openChannel(channel);
    }

    /** The channel a read-from-the-start was asked for, cleared by whoever acts on it. */
    readonly readFromStart = signal<string | null>(null);

    /** True when the given channel is the one currently shown in the main view. */
    isChannelActive(channelId: string): boolean {
        const view = this.mainView();
        return view.type === 'channel' && view.channel.id === channelId;
    }

    /** The wiki is a main view and nothing else; it lays out its own tree internally. */
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

    /** The cast list. Guild-scoped like the wiki, and for the same reason. */
    openPersonas(guildId: string): void {
        const current = this.mainView();
        if (current.type !== 'personas' || current.guildId !== guildId) {
            this.mainView.set({type: 'personas', guildId});
            this.saveNav();
        }
        this.mobileNavOpen.set(false);
    }

    /** Which half the board was last on, so leaving it and coming back does not reset to playing. */
    private sceneMode: SceneBoardMode = 'playing';
    /** The shelf both halves were last filtered to, kept for the same reason as {@link sceneMode}. */
    private sceneFolderId: string | null = null;

    /** The scene board. Guild-scoped like the wiki, and for the same reason. */
    openScenes(guildId: string, mode: SceneBoardMode = this.sceneMode): void {
        this.showScenes(guildId, mode, this.sceneFolderId, null);
    }

    /** Filters both halves to one shelf. Null is every shelf, `UNFILED` the no-shelf bucket. */
    openSceneFolder(guildId: string, folderId: string | null, mode: SceneBoardMode = this.sceneMode): void {
        this.showScenes(guildId, mode, folderId, null);
    }

    /** Opens a scene inside the shell, with the rail and the breadcrumb beside it. */
    openSceneChannel(guildId: string, channelId: string): void {
        this.showScenes(guildId, this.sceneMode, this.sceneFolderId, channelId);
    }

    /**
     * Steps out of a hosted scene. Drops the run of scenes it was reached through rather than
     * pushing another entry, so one Back leaves the shell however many scenes were hopped between.
     */
    closeSceneChannel(guildId: string): void {
        while (this.cursor > 0 && isHostedScene(this.history[this.cursor].mainView)) this.cursor--;
        this.history.length = this.cursor + 1;
        this.refreshHistoryFlags();
        this.showScenes(guildId, this.sceneMode, this.sceneFolderId, null);
    }

    private showScenes(
        guildId: string,
        mode: SceneBoardMode,
        folderId: string | null,
        sceneChannelId: string | null,
    ): void {
        this.sceneMode = mode;
        this.sceneFolderId = folderId;
        const current = this.mainView();
        const same =
            current.type === 'scenes' &&
            current.guildId === guildId &&
            current.mode === mode &&
            (current.folderId ?? null) === folderId &&
            (current.sceneChannelId ?? null) === sceneChannelId;
        if (!same) {
            this.mainView.set({type: 'scenes', guildId, mode, folderId, sceneChannelId});
            this.saveNav();
        }
        this.mobileNavOpen.set(false);
    }

    /** Steps off the board when the module goes away underneath the reader. */
    leaveScenes(): void {
        if (this.mainView().type !== 'scenes') return;
        this.leaveGuildView();
    }

    openCharacter(guildId: string, personaId: string): void {
        this.mainView.set({type: 'character', guildId, personaId});
        this.mobileNavOpen.set(false);
        this.saveNav();
    }

    /** Steps off both persona views when the module goes away underneath the reader. */
    leavePersonas(): void {
        const view = this.mainView().type;
        if (view !== 'personas' && view !== 'character') return;
        this.leaveGuildView();
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
            case 'personas':
                return `${ws}|personas:${view.guildId}`;
            case 'character':
                return `${ws}|character:${view.personaId}`;
            case 'scenes':
                return `${ws}|scenes:${view.guildId}:${view.folderId ?? ''}:${view.sceneChannelId ?? ''}`;
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
            state =
                view.type === 'conversation'
                    ? {kind: 'dms-conversation', conversationId: view.conversation.id}
                    : {kind: 'dms-home'};
        } else {
            if (view.type === 'wiki') {
                state = {kind: 'server-wiki', guildId: ws.guild.id};
            } else if (view.type === 'personas' || view.type === 'character') {
                // A character page is restored as the cast list: the persona may have been retired,
                // renamed or dropped from the guild while the app was closed.
                state = {kind: 'server-personas', guildId: ws.guild.id};
            } else if (view.type === 'scenes') {
                state = {
                    kind: 'server-scenes',
                    guildId: ws.guild.id,
                    sceneMode: view.mode,
                    sceneFolderId: view.folderId ?? null,
                    sceneChannelId: view.sceneChannelId ?? null,
                };
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
        } catch {}
    }
}

/** A scenes view with a scene in its content pane, as opposed to the board or the archive. */
function isHostedScene(view: MainView): boolean {
    return view.type === 'scenes' && !!view.sceneChannelId;
}
