import {
    Component,
    computed,
    DestroyRef,
    effect,
    HostListener,
    inject,
    input,
    signal,
    untracked,
    ViewChild,
    viewChild,
} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {firstValueFrom} from 'rxjs';
import {NgClass} from '@angular/common';
import {ContextMenuComponent} from '../../../../shared/context-menu/context-menu.component';
import {Popover} from 'primeng/popover';
import {Button} from 'primeng/button';
import {Dialog} from 'primeng/dialog';
import {InputText} from 'primeng/inputtext';
import {PrimeTemplate} from 'primeng/api';
import {MenuItem, MenuItemCommandEvent} from '../../../../shared/context-menu/context-menu.model';
import {CategoryDto, ChannelDto, ChannelType, GuildDto} from '../../../../dtos/response/guild.dto';
import {NavigationService} from '../../../main-page/navigation.service';
import {GuildService} from '../../../../services/guild.service';
import {OwnMemberRevisionService} from '../../../../services/own-member-revision.service';
import {VoiceChannelParticipant, VoiceChannelService} from '../../../../services/voice-channel.service';
import {CallFocusService} from '../../../../services/call-focus.service';
import {scopeKey} from '../../../../services/share-watch.service';
import {CallContextMenuComponent} from '../../../../shared/call/call-context-menu/call-context-menu.component';
import {VoiceRingPickerComponent} from '../../../../shared/call/voice-ring-picker/voice-ring-picker.component';
import {CallParticipantMenuData} from '../../../../shared/call/call.types';
import {InviteNudgeService} from '../../../../services/invite-nudge.service';
import {ChannelInvitePanelComponent} from './components/channel-invite-panel/channel-invite-panel.component';
import {ProfileService} from '../../../../services/profile.service';
import {GuildReadStateService} from '../../../../services/guild-read-state.service';
import {GuildSettingsModalComponent} from '../guild-settings-modal/guild-settings-modal.component';
import {SettingsUiService} from '../../../../services/settings-ui.service';
import {ChannelSettingsModalComponent} from '../channel-settings-modal/channel-settings-modal.component';
import {CategorySettingsModalComponent} from '../category-settings-modal/category-settings-modal.component';
import {InviteType} from '../../../../dtos/response/invite.dto';
import {SelfGuildMemberDto} from '../../../../dtos/response/member.dto';
import {hasPermission, parsePermissions, Permissions} from '../../../../enums/permissions.enum';
import {memberCanManageGuild, unionMemberPermissions} from '../../guild-permissions';
import {GuildFeature, guildFeatures, hasHouseholdModule} from '../../guild-features';
import {
    WsCategoryCreated,
    WsCategoryDeleted,
    WsCategoryUpdated,
    WsChannelCreated,
    WsChannelDeleted,
    WsChannelUpdated,
} from '../../../../dtos/response/guild-channel-events.dto';
import {GuildVoiceService} from '../../../../services/guild-voice.service';
import {GuildUiActionsService} from '../../../../services/guild-ui-actions.service';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {ChannelListDragService} from './channel-list-drag.service';
import {CreateChannelModalComponent} from './components/create-channel-modal/create-channel-modal.component';
import {CreateCategoryModalComponent} from './components/create-category-modal/create-category-modal.component';
import {ChannelListItemsComponent} from './components/channel-list-items/channel-list-items.component';
import {ChannelDropIndicatorComponent} from './components/channel-drop-indicator/channel-drop-indicator.component';
import {SceneNavComponent} from './components/scene-nav/scene-nav.component';
import {ChannelsAndRolesModalComponent} from '../channels-and-roles/channels-and-roles-modal.component';
import {GuildOnboardingStateService} from '../../../../services/guild-onboarding-state.service';
import {ScheduledEventStore} from '../../../../stores/scheduled-event.store';
import {SceneService} from '../../../../services/scene.service';
import {SceneRailStateService} from '../../../../services/scene-rail-state.service';
import {MinuteClockService} from '../../../../services/minute-clock.service';
import {phaseOf} from '../events-panel/event-timing';
import {ViewAsBannerComponent} from '../../view-as/view-as-banner.component';
import {ViewAsPickerComponent} from '../../view-as/view-as-picker.component';
import {ViewAsService} from '../../view-as/view-as.service';
import {RealtimeConnectionService} from '../../../../services/realtime-connection.service';

@Component({
    selector: 'app-channel-list',
    providers: [ChannelListDragService],
    imports: [
        NgClass,
        ContextMenuComponent,
        Popover,
        Button,
        Dialog,
        InputText,
        ChannelListItemsComponent,
        ChannelDropIndicatorComponent,
        SceneNavComponent,
        GuildSettingsModalComponent,
        ChannelSettingsModalComponent,
        CategorySettingsModalComponent,
        CreateChannelModalComponent,
        CreateCategoryModalComponent,
        PrimeTemplate,
        CallContextMenuComponent,
        ChannelsAndRolesModalComponent,
        ChannelInvitePanelComponent,
        VoiceRingPickerComponent,
        ViewAsBannerComponent,
        ViewAsPickerComponent,
        TranslateModule,
    ],
    templateUrl: './channel-list.component.html',
})
export class ChannelListComponent {
    readonly guild = input.required<GuildDto>();
    // ── Context menu refs ─────────────────────────────────────────────────────
    readonly guildMenu = viewChild.required<ContextMenuComponent>('guildMenu');
    readonly channelMenu = viewChild.required<ContextMenuComponent>('channelMenu');
    readonly categoryMenu = viewChild.required<ContextMenuComponent>('categoryMenu');
    readonly listMenu = viewChild.required<ContextMenuComponent>('listMenu');
    @ViewChild('invitePopover') invitePopover!: Popover;
    @ViewChild(GuildSettingsModalComponent) guildSettingsModal?: GuildSettingsModalComponent;
    @ViewChild(ChannelSettingsModalComponent) channelSettingsModal?: ChannelSettingsModalComponent;
    @ViewChild(CategorySettingsModalComponent) categorySettingsModal?: CategorySettingsModalComponent;
    @ViewChild(CreateChannelModalComponent) createChannelModal?: CreateChannelModalComponent;
    @ViewChild(CreateCategoryModalComponent) createCategoryModal?: CreateCategoryModalComponent;
    protected readonly ChannelType = ChannelType;
    protected navService = inject(NavigationService);
    protected drag = inject(ChannelListDragService);
    private voiceChannelSvc = inject(VoiceChannelService);
    private callFocus = inject(CallFocusService);
    private profileService = inject(ProfileService);
    private readStateService = inject(GuildReadStateService);
    // ── Local mutable copies for optimistic updates ───────────────────────────
    protected readonly localChannels = signal<ChannelDto[]>([]);
    protected readonly localCategories = signal<CategoryDto[]>([]);
    // ── Computed channel groups (sorted by position) ──────────────────────────
    // Nested channels (threads, forum posts) arrive alongside top-level channels but belong to their parent's own UI, never the sidebar.
    protected readonly uncategorizedChannels = computed(() =>
        this.localChannels()
            .filter(c => !c.categoryId && !c.parentChannelId)
            .sort((a, b) => a.position - b.position),
    );
    protected readonly sortedCategories = computed(() =>
        [...this.localCategories()].sort((a, b) => a.position - b.position),
    );
    protected readonly isWikiActive = computed(() => {
        const view = this.navService.mainView();
        return view.type === 'wiki' && view.guildId === this.guild().id;
    });
    protected readonly isHouseActive = computed(() => {
        const view = this.navService.mainView();
        return view.type === 'house' && view.guildId === this.guild().id;
    });
    protected readonly isPersonasActive = computed(() => {
        const view = this.navService.mainView();
        return (view.type === 'personas' || view.type === 'character') && view.guildId === this.guild().id;
    });
    // ── Scenes ────────────────────────────────────────────────────────────────
    protected readonly scenes = inject(SceneService);
    private readonly sceneRail = inject(SceneRailStateService);
    protected readonly isScenesActive = computed(() => {
        const view = this.navService.mainView();
        return view.type === 'scenes' && view.guildId === this.guild().id;
    });
    /** The one ambient signal that a game is waiting: a count, in the sidebar, and no toast. */
    protected readonly waitingSceneCount = computed(() => this.scenes.waitingOnMeCount(this.guild().id));

    /** Shared with app-scene-nav through the rail state, so both halves of the row agree. */
    protected readonly sceneTreeOpen = computed(() => this.sceneRail.navOpen(this.guild().id));

    protected toggleSceneTree(): void {
        this.sceneRail.setNavOpen(this.guild().id, !this.sceneTreeOpen());
    }

    // ── Events ────────────────────────────────────────────────────────────────
    private eventStore = inject(ScheduledEventStore);
    private minuteClock = inject(MinuteClockService);
    protected readonly isEventsActive = computed(
        () => this.navService.eventsPanelGuildId() === this.guild().id,
    );
    private readonly guildEvents = computed(() => this.eventStore.eventsForGuild(this.guild().id));
    protected readonly hasLiveEvent = computed(() =>
        this.guildEvents().some(e => phaseOf(e, this.minuteClock.now()) === 'live'),
    );
    protected readonly upcomingEventCount = computed(
        () => this.guildEvents().filter(e => phaseOf(e, this.minuteClock.now()) === 'upcoming').length,
    );
    // ── Modules ───────────────────────────────────────────────────────────────
    // Hidden, not disabled: an off module is absent from navigation, but existing channels of a disabled type stay put; switching Forums off blocks creating new ones, not removing existing ones.
    protected readonly features = computed(() => guildFeatures(this.guild()));
    protected readonly hasWiki = computed(() => this.features().has(GuildFeature.Wiki));
    protected readonly hasPersonas = computed(() => this.features().has(GuildFeature.Personas));
    protected readonly hasScenes = computed(() => this.features().has(GuildFeature.Scenes));
    /** Any one of the six digest modules; the digest nulls the sections it cannot answer. */
    protected readonly hasHouse = computed(() => hasHouseholdModule(this.guild()));
    protected readonly hasEvents = computed(() => this.features().has(GuildFeature.Events));
    protected readonly hasOnboarding = computed(() => this.features().has(GuildFeature.Onboarding));
    protected readonly hasModeration = computed(() => this.features().has(GuildFeature.Moderation));
    // ── Modal visibility ──────────────────────────────────────────────────────
    protected readonly showGuildSettings = signal(false);
    protected readonly showChannelSettings = signal(false);
    protected readonly showCategorySettings = signal(false);
    protected readonly showChannelsAndRoles = signal(false);

    private onboardingState = inject(GuildOnboardingStateService);

    /** True only when prompts with `inOnboarding: true` exist; prompts with `inOnboarding: false` never reach this status payload and won't show a link. */
    protected readonly hasSelfServeRoles = computed(
        () =>
            this.hasOnboarding() &&
            (this.onboardingState.statusFor(this.guild().id)?.prompts?.length ?? 0) > 0,
    );
    // ── Quick invite dialog ───────────────────────────────────────────────────
    protected readonly showInviteDialog = signal(false);
    protected readonly inviteLink = signal('');
    protected readonly inviteLoading = signal(false);
    protected readonly inviteCopied = signal(false);
    // ── Per-person invite panel ───────────────────────────────────────────────
    /** The channel the quick invite panel is open for; null also means the panel is closed, since its body only renders while this holds a channel. */
    protected readonly invitePanelChannel = signal<ChannelDto | null>(null);
    /** Search everyone. Held separately because opening it closes the panel that asked for it. */
    protected readonly pickerChannel = signal<ChannelDto | null>(null);
    protected readonly showRingPicker = signal(false);
    // ── Create channel / category dialogs ─────────────────────────────────────
    protected readonly showCreateChannel = signal(false);
    protected readonly showCreateCategory = signal(false);

    // ── Drag delegates (HostListener must stay in component) ──────────────────
    protected readonly contextChannel = signal<ChannelDto | null>(null);
    protected readonly contextCategory = signal<CategoryDto | null>(null);
    // ── Guild header dropdown items ───────────────────────────────────────────
    protected readonly guildMenuItems = computed<MenuItem[]>(() => [
        // Server Settings and the view-as preview are the only entries here that need elevated
        // permission; copying the ID, creating channels and inviting are checked by their own flows.
        ...(this.canManageGuild()
            ? [
                  {
                      label: 'Server Settings',
                      icon: 'pi pi-cog',
                      command: () => this.showGuildSettings.set(true),
                  },
                  {
                      label: this.translate.instant('VIEW_AS.MENU'),
                      icon: 'pi pi-eye',
                      command: () => this.showViewAsPicker.set(true),
                  },
              ]
            : []),
        {
            label: 'Copy Server ID',
            icon: 'pi pi-copy',
            command: () => navigator.clipboard.writeText(this.guild().id),
        },
        {separator: true},
        {
            label: 'Create Channel',
            icon: 'pi pi-plus',
            command: () => this.openCreateChannel(undefined),
        },
        {
            label: 'Create Category',
            icon: 'pi pi-folder-plus',
            command: () => this.openCreateCategory(),
        },
        {separator: true},
        {
            label: 'Create Invite',
            icon: 'pi pi-link',
            command: () => this.quickCreateInvite(),
        },
    ]);
    // ── Voice participant context menu ────────────────────────────────────────
    protected readonly participantMenu = signal<CallParticipantMenuData | null>(null);
    private guildService = inject(GuildService);
    private inviteNudge = inject(InviteNudgeService);
    private ownMemberRevision = inject(OwnMemberRevisionService);
    private guildVoiceSvc = inject(GuildVoiceService);
    private guildUiActions = inject(GuildUiActionsService);
    private realtime = inject(RealtimeConnectionService);
    private settingsUi = inject(SettingsUiService);
    private destroyRef = inject(DestroyRef);
    private translate = inject(TranslateService);
    // ── Permission checking ───────────────────────────────────────────────────
    private readonly ownMember = signal<SelfGuildMemberDto | null>(null);
    protected readonly getSelfPermissions = computed(() => unionMemberPermissions(this.ownMember()));
    protected readonly canReorder = computed(() => {
        const ownUserId = this.profileService.ownProfile()?.userId;
        if (ownUserId && ownUserId === this.guild().ownerId) return true;
        const member = this.ownMember();
        if (!member) return false;
        const perms = this.getSelfPermissions();
        return (
            hasPermission(perms, Permissions.Superadmin) || hasPermission(perms, Permissions.ManageChannel)
        );
    });
    protected readonly isSuperadmin = computed(() => {
        const ownUserId = this.profileService.ownProfile()?.userId;
        if (ownUserId && ownUserId === this.guild().ownerId) return true;
        const m = this.ownMember();
        if (!m) return false;
        return hasPermission(parsePermissions(m.permissions), Permissions.Superadmin);
    });
    protected readonly canManageGuild = computed(() =>
        memberCanManageGuild(
            this.ownMember(),
            this.guild().ownerId,
            this.profileService.ownProfile()?.userId,
        ),
    );

    // ── View as ───────────────────────────────────────────────────────────────
    protected readonly showViewAsPicker = signal(false);
    protected readonly viewAs = inject(ViewAsService);
    protected readonly viewAsActive = computed(() => this.viewAs.active(this.guild().id)());

    /** Requests every top-level channel's trace once the mode turns on. */
    private readonly viewAsRequests = effect(() => {
        if (!this.viewAsActive()) return;
        const guildId = this.guild().id;
        for (const channel of this.localChannels()) this.viewAs.request(guildId, channel.id);
    });

    protected readonly viewAsVisibleCount = computed(
        () =>
            this.localChannels().filter(c => this.viewAs.can(this.guild().id, c.id, Permissions.ViewChannel))
                .length,
    );

    /** Channel ids the previewed subject cannot see, dimmed rather than dropped from the list. */
    protected readonly viewAsHiddenIds = computed(() => {
        if (!this.viewAsActive()) return new Set<string>();
        return new Set(
            this.localChannels()
                .filter(c => !this.canSee(c))
                .map(c => c.id),
        );
    });

    protected canSee(channel: ChannelDto): boolean {
        if (!this.viewAsActive()) return true;
        return this.viewAs.can(this.guild().id, channel.id, Permissions.ViewChannel);
    }

    /**
     * Voice channels visible to the subject but not joinable: `Connect` implies `ViewChannel`, not
     * the reverse, so this is a real, distinct state from "hidden" and must read as its own thing
     * rather than as full access.
     */
    protected readonly viewAsUnjoinableIds = computed(() => {
        if (!this.viewAsActive()) return new Set<string>();
        return new Set(
            this.localChannels()
                .filter(
                    c =>
                        c.type === ChannelType.Voice &&
                        this.canSee(c) &&
                        !this.viewAs.can(this.guild().id, c.id, Permissions.Connect),
                )
                .map(c => c.id),
        );
    });

    /** Set only between a move's `hide` and the `show` that follows it. @see openInvitePanel */
    private invitePanelMovingTo: ChannelDto | null = null;
    // ── Collapse state ────────────────────────────────────────────────────────
    private readonly collapsedIds = signal(new Set<string>());
    private readonly participantChannelId = signal<string | null>(null);

    constructor() {
        effect(() => {
            this.voiceChannelSvc.loadVoiceStatesForGuild(this.guild().channels, this.guild().id);
        });

        effect(() => {
            // Reads guild() so a guild switch retries a seed that failed; the seed itself is global (one for every guild, not per server).
            this.guild();
            void this.readStateService.ensureSeeded();
        });

        effect(() => {
            this.localChannels.set([...this.guild().channels]);
            this.localCategories.set([...this.guild().categories]);
        });

        effect(() => {
            const guildId = this.guild().id;
            // Re-runs when guild.MemberUpdated says our own roles changed.
            this.ownMemberRevision.revision();
            this.guildService.getOwnMember(guildId).subscribe(m => this.ownMember.set(m));
        });

        this.minuteClock.retain();

        // This component is instantiated per guild; only consume the request when it names this guild, or another guild's list would have its request swallowed before it sees it.
        effect(() => {
            const request = this.settingsUi.requestedGuildPage();
            if (!request || request.guildId !== this.guild().id) return;
            this.settingsUi.consumeGuild();
            untracked(() => {
                this.guildSettingsModal?.activePage.set(request.page);
                this.showGuildSettings.set(true);
            });
        });

        // Also marks the guild isTracked in the store, which applyRealtimeCreatedOrUpdated requires; without it, events created by others are dropped until the panel has been opened once.
        effect(() => {
            const guildId = this.guild().id;
            if (!this.hasEvents()) return;
            untracked(() => this.eventStore.loadFor(guildId));
        });

        // The badge has to be right before anything is opened, so the board is loaded from here.
        effect(() => {
            const guildId = this.guild().id;
            if (!this.hasScenes()) return;
            untracked(() => this.scenes.ensureGuild(guildId));
        });

        // Switching a module off while its view is open would strand the user on a screen whose entry point just disappeared from the sidebar.
        effect(() => {
            const guildId = this.guild().id;
            const view = this.navService.mainView();
            const wikiGone = !this.hasWiki() && view.type === 'wiki' && view.guildId === guildId;
            const houseGone = !this.hasHouse() && view.type === 'house' && view.guildId === guildId;
            const eventsGone = !this.hasEvents() && this.navService.eventsPanelGuildId() === guildId;
            const personasGone =
                !this.hasPersonas() &&
                (view.type === 'personas' || view.type === 'character') &&
                view.guildId === guildId;
            const scenesGone = !this.hasScenes() && view.type === 'scenes' && view.guildId === guildId;
            untracked(() => {
                if (wikiGone) this.navService.leaveWiki();
                if (personasGone) this.navService.leavePersonas();
                if (scenesGone) this.navService.leaveScenes();
                if (houseGone) this.navService.leaveHouse();
                if (eventsGone) this.navService.closeEventsPanel();
            });
        });

        this.drag.setup(() => this.guild().id, this.localChannels, this.localCategories);

        this.realtime
            .stream('guild.ChannelReordered')
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(dto => {
                if (dto.channels.length > 0) {
                    const posMap = new Map(dto.channels.map(c => [c.channelId, c.position]));
                    this.localChannels.update(channels =>
                        channels.map(c => (posMap.has(c.id) ? {...c, position: posMap.get(c.id)!} : c)),
                    );
                }
                if (dto.categories.length > 0) {
                    const catMap = new Map(dto.categories.map(c => [c.categoryId, c.position]));
                    this.localCategories.update(cats =>
                        cats.map(c => (catMap.has(c.id) ? {...c, position: catMap.get(c.id)!} : c)),
                    );
                }
            });

        this.realtime
            .stream('guild.ChannelCreated')
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((e: WsChannelCreated) => {
                if (e.guildId !== this.guild().id) return;
                this.guildService.getGuild(e.guildId).subscribe(g => {
                    const ch = g.channels.find(c => c.id === e.channelId);
                    if (ch && !this.guild().channels.some(c => c.id === e.channelId)) {
                        this.patchGuild({channels: [...this.guild().channels, ch]});
                    }
                });
            });

        this.realtime
            .stream('guild.ChannelDeleted')
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((e: WsChannelDeleted) => {
                if (e.guildId !== this.guild().id) return;
                if (this.voiceChannelSvc.joinedChannelId() === e.channelId) {
                    void this.voiceChannelSvc.leaveChannel();
                }
                const remaining = this.guild().channels.filter(c => c.id !== e.channelId);
                this.patchGuild({channels: remaining});
                if (this.navService.isChannelActive(e.channelId)) {
                    const firstText = remaining.find(c => c.type === ChannelType.Text);
                    if (firstText) {
                        this.navService.openChannel(firstText);
                    } else {
                        this.navService.showHome();
                    }
                }
            });

        this.realtime
            .stream('guild.ChannelUpdated')
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((e: WsChannelUpdated) => {
                if (e.guildId !== this.guild().id) return;
                this.guildService.getGuild(e.guildId).subscribe(g => {
                    const ch = g.channels.find(c => c.id === e.channelId);
                    if (!ch) return;
                    this.patchGuild({channels: this.guild().channels.map(c => (c.id === ch.id ? ch : c))});
                });
            });

        this.realtime
            .stream('guild.CategoryCreated')
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((e: WsCategoryCreated) => {
                if (e.guildId !== this.guild().id) return;
                this.guildService.getGuild(e.guildId).subscribe(g => {
                    const cat = g.categories.find(c => c.id === e.categoryId);
                    if (cat && !this.guild().categories.some(c => c.id === e.categoryId)) {
                        this.patchGuild({categories: [...this.guild().categories, cat]});
                    }
                });
            });

        // Re-read like ChannelUpdated: the payload only names the category, not what changed, and position may be part of it.
        this.realtime
            .stream('guild.CategoryUpdated')
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((e: WsCategoryUpdated) => {
                if (e.guildId !== this.guild().id) return;
                this.guildService.getGuild(e.guildId).subscribe(g => {
                    const cat = g.categories.find(c => c.id === e.categoryId);
                    if (!cat) return;
                    const known = this.guild().categories.some(c => c.id === cat.id);
                    this.patchGuild({
                        categories: known
                            ? this.guild().categories.map(c => (c.id === cat.id ? cat : c))
                            : [...this.guild().categories, cat],
                    });
                });
            });

        this.realtime
            .stream('guild.CategoryDeleted')
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((e: WsCategoryDeleted) => {
                if (e.guildId !== this.guild().id) return;
                this.patchGuild({
                    categories: this.guild().categories.filter(c => c.id !== e.categoryId),
                    channels: this.guild().channels.map(c =>
                        c.categoryId === e.categoryId ? {...c, categoryId: undefined} : c,
                    ),
                });
            });

        this.guildUiActions.openCreateChannel$
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(() => this.openCreateChannel(undefined));

        this.guildUiActions.openCreateCategory$
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(() => this.openCreateCategory());
    }

    protected onGuildUpdated(updated: GuildDto): void {
        this.navService.updateCurrentGuild(updated);
    }

    /** Merges a partial change into the shared guild so every consumer of `guild()` (system channel picker, audit log, etc.) sees it, not just this component's local copies. */
    private patchGuild(partial: Partial<GuildDto>): void {
        this.navService.updateCurrentGuild({...this.guild(), ...partial});
    }

    protected onChannelUpdated(updated: ChannelDto): void {
        this.patchGuild({channels: this.guild().channels.map(c => (c.id === updated.id ? updated : c))});
    }

    protected onCategoryUpdated(updated: CategoryDto): void {
        this.patchGuild({categories: this.guild().categories.map(c => (c.id === updated.id ? updated : c))});
    }

    protected categoryChannels(categoryId: string): ChannelDto[] {
        return this.localChannels()
            .filter(c => c.categoryId === categoryId && !c.parentChannelId)
            .sort((a, b) => a.position - b.position);
    }

    protected openWiki(): void {
        this.navService.openWiki(this.guild().id);
    }

    protected openScenes(): void {
        this.navService.openScenes(this.guild().id);
    }

    protected openPersonas(): void {
        this.navService.openPersonas(this.guild().id);
    }

    protected openHouse(): void {
        this.navService.openHouse(this.guild().id);
    }

    protected toggleEvents(): void {
        this.navService.toggleEventsPanel(this.guild().id);
    }

    protected onChannelClick(channel: ChannelDto): void {
        this.navService.openChannel(channel);
    }

    protected onVoiceChannelClick(channel: ChannelDto): void {
        this.navService.openChannel(channel);
        if (this.voiceChannelSvc.joinedChannelId() !== channel.id) {
            void this.voiceChannelSvc.joinChannel(channel, this.guild().name);
        }
        this.navService.mobileNavOpen.set(false);
    }

    /**
     * Opens the channel and joins voice exactly as a plain row click would, then arms a focus
     * request for that user's stream. The badge sits inside a row that already joins on click, so a
     * badge click that only opened the channel gave strictly less than clicking beside it - matching
     * the row is what `CALL.JOIN_AND_WATCH` already implies. `CallScreenLayoutComponent` consumes the
     * request once the stage mounts; if it is not consumed in time it lapses on its own TTL.
     */
    protected async onWatchStream(event: {channel: ChannelDto; userId: string}): Promise<void> {
        this.navService.openChannel(event.channel);
        if (this.voiceChannelSvc.joinedChannelId() !== event.channel.id) {
            // A refused join has already said so. Arming a focus request on top of it would point
            // the stage at a room this client is not in.
            if (!(await this.voiceChannelSvc.joinChannel(event.channel, this.guild().name))) return;
        }
        this.callFocus.request(
            scopeKey({kind: 'channel', guildId: event.channel.guildId, channelId: event.channel.id}),
            {userId: event.userId},
        );
    }

    protected isCollapsed(id: string): boolean {
        return this.collapsedIds().has(id);
    }

    protected toggleCollapse(id: string): void {
        this.collapsedIds.update(set => {
            const next = new Set(set);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    }

    @HostListener('document:dragover', ['$event'])
    protected onGlobalDragOver(event: DragEvent): void {
        this.drag.onGlobalDragOver(event);
    }

    @HostListener('document:dragenter', ['$event'])
    protected onGlobalDragEnter(event: DragEvent): void {
        this.drag.onGlobalDragEnter(event);
    }

    @HostListener('document:drop', ['$event'])
    protected onGlobalDrop(event: DragEvent): void {
        this.drag.onGlobalDrop(event);
    }

    protected buildChannelMenuItems(channel: ChannelDto): MenuItem[] {
        return [
            {
                label: 'Edit Channel',
                icon: 'pi pi-pencil',
                command: () => this.channelSettingsModal?.open(channel, this.guild()),
            },
            // Voice channels only: the endpoint behind it answers 400 for anything else. Opens its panel on hover as well as on click, so it carries both.
            ...(channel.type === ChannelType.Voice
                ? [
                      {
                          id: 'invite',
                          label: 'Invite People',
                          icon: 'pi pi-user-plus',
                          chevron: true,
                          hover: (e: MenuItemCommandEvent) =>
                              this.openInvitePanel(e.originalEvent as MouseEvent, channel),
                          command: (e: MenuItemCommandEvent) =>
                              this.openInvitePanel(e.originalEvent as MouseEvent, channel),
                      },
                  ]
                : []),
            {
                label: 'Create Invite',
                icon: 'pi pi-link',
                command: () => this.quickCreateInvite(),
            },
            {separator: true},
            {
                label: 'Copy Channel ID',
                icon: 'pi pi-copy',
                command: () => navigator.clipboard.writeText(channel.id),
            },
            {separator: true},
            {
                label: 'Delete Channel',
                icon: 'pi pi-trash',
                danger: true,
                command: () => this.channelSettingsModal?.open(channel, this.guild()),
            },
        ];
    }

    protected buildCategoryMenuItems(category: CategoryDto): MenuItem[] {
        return [
            {
                label: 'Edit Category',
                icon: 'pi pi-pencil',
                command: () => this.categorySettingsModal?.open(category, this.guild()),
            },
            {
                label: 'Create Channel in Category',
                icon: 'pi pi-plus',
                command: () => this.openCreateChannel(category.id),
            },
            {separator: true},
            {
                label: 'Delete Category',
                icon: 'pi pi-trash',
                danger: true,
                command: () => this.categorySettingsModal?.open(category, this.guild()),
            },
        ];
    }

    protected toggleGuildMenu(event: MouseEvent): void {
        this.guildMenu().toggle(event);
    }

    protected onChannelContextMenu(event: MouseEvent, channel: ChannelDto): void {
        event.preventDefault();
        event.stopPropagation();
        this.contextChannel.set(channel);
        this.channelMenu().show(event, this.buildChannelMenuItems(channel));
    }

    protected onCategoryContextMenu(event: MouseEvent, category: CategoryDto): void {
        event.preventDefault();
        event.stopPropagation();
        this.contextCategory.set(category);
        this.categoryMenu().show(event, this.buildCategoryMenuItems(category));
    }

    protected onListContextMenu(event: MouseEvent): void {
        this.listMenu().show(event);
    }

    // ── Per-person invite panel ───────────────────────────────────────────────
    /** Opens the five-name panel where the user pointed, anchored to the event's own element (not the channel row) since the menu item and the empty seat sit in different places. */
    protected openInvitePanel(event: MouseEvent, channel: ChannelDto | null): void {
        if (!channel) return;
        // Already open over this channel: a mouse leaving for the panel and returning across the item it came from is not a second request to open it.
        const open = this.invitePanelChannel();
        if (open?.id === channel.id) return;

        // Reaching for it is the interaction the row's fifteen seconds were waiting for.
        this.inviteNudge.keep();

        if (!open) {
            this.invitePanelChannel.set(channel);
            // Anchored via show(event) alone, never show(event, target): that overload stops the click, but the menu this came from needs to see it in order to close.
            this.invitePopover.show(event);
            return;
        }

        // Moving to a different channel: a popover only measures its position on enter, so an already-open one must hide before re-anchoring, or it stays beside the old row.
        const anchor = event.currentTarget as HTMLElement;
        this.invitePanelMovingTo = channel;
        this.invitePopover.hide();

        setTimeout(() => {
            const next = this.invitePanelMovingTo;
            this.invitePanelMovingTo = null;
            if (!next) return;

            this.invitePanelChannel.set(next);
            this.invitePopover.show({currentTarget: anchor} as unknown as MouseEvent);
        });
    }

    protected onInvitePanelHide(): void {
        // Half of a move rather than a close: the reopen above owns the channel from here.
        if (this.invitePanelMovingTo) return;
        this.invitePanelChannel.set(null);
    }

    /** Five names give way to the whole roster. The panel closes behind it. */
    protected openRingPicker(): void {
        this.pickerChannel.set(this.invitePanelChannel());
        this.invitePopover.hide();
        this.showRingPicker.set(true);
    }

    /** Who is in the room already, so neither surface offers somebody who is standing in it. */
    protected participantIdsOf(channelId: string): string[] {
        return (this.voiceChannelSvc.channelParticipants().get(channelId) ?? []).map(p => p.userId);
    }

    // ── Quick invite ──────────────────────────────────────────────────────────
    protected quickCreateInvite(): void {
        this.inviteLink.set('');
        this.inviteCopied.set(false);
        this.inviteLoading.set(true);
        this.showInviteDialog.set(true);
        this.guildService.createInvite({type: InviteType.Permanent}, this.guild().id).subscribe({
            next: invite => {
                this.inviteLink.set(`https://venta.gg/invite/${invite.code}`);
                this.inviteLoading.set(false);
            },
            error: () => this.inviteLoading.set(false),
        });
    }

    protected copyInviteLink(): void {
        navigator.clipboard.writeText(this.inviteLink()).then(() => {
            this.inviteCopied.set(true);
            setTimeout(() => this.inviteCopied.set(false), 2000);
        });
    }

    protected onParticipantContextMenu(
        event: MouseEvent,
        p: VoiceChannelParticipant,
        channelId: string,
    ): void {
        event.preventDefault();
        event.stopPropagation();
        if (p.isLocal) return;
        const volume = Math.round(this.voiceChannelSvc.getUserVolume(p.userId) * 100);
        // Left undefined when not sharing; the menu template reads that to decide whether the second slider has anything to control.
        const streamVolume = p.isScreenSharing
            ? Math.round(this.voiceChannelSvc.getScreenVolume(p.userId) * 100)
            : undefined;
        const x = Math.min(event.clientX, window.innerWidth - 236);
        const y = Math.min(event.clientY, window.innerHeight - 200);
        this.participantChannelId.set(channelId);
        this.participantMenu.set({
            x: Math.max(0, x),
            y: Math.max(0, y),
            participant: p,
            volume,
            streamVolume,
        });
    }

    protected onParticipantVolumeChange(value: number): void {
        const menu = this.participantMenu();
        if (!menu) return;
        this.participantMenu.set({...menu, volume: value});
        this.voiceChannelSvc.setUserVolume(menu.participant.userId, value / 100);
    }

    protected onParticipantStreamVolumeChange(value: number): void {
        const menu = this.participantMenu();
        if (!menu) return;
        this.participantMenu.set({...menu, streamVolume: value});
        this.voiceChannelSvc.setScreenVolume(menu.participant.userId, value / 100);
    }

    protected async kickParticipant(): Promise<void> {
        const menu = this.participantMenu();
        if (!menu) return;
        this.participantMenu.set(null);
        await firstValueFrom(
            this.guildService.kickMemberByUserId(this.guild().id, menu.participant.userId),
        ).catch(() => {});
    }

    protected async banParticipant(): Promise<void> {
        const menu = this.participantMenu();
        if (!menu) return;
        this.participantMenu.set(null);
        await firstValueFrom(
            this.guildService.banMember(this.guild().id, {userId: menu.participant.userId}),
        ).catch(() => {});
    }

    protected async toggleParticipantServerDeafen(): Promise<void> {
        const menu = this.participantMenu();
        const channelId = this.participantChannelId();
        if (!menu || !channelId) return;
        const {userId, isServerDeafened} = menu.participant as VoiceChannelParticipant;
        const newState = !isServerDeafened;
        this.participantMenu.set({...menu, participant: {...menu.participant, isServerDeafened: newState}});
        this.voiceChannelSvc.setServerDeafened(userId, newState);
        await firstValueFrom(
            this.guildVoiceSvc.serverDeafen(this.guild().id, channelId, userId, newState),
        ).catch(() => {
            this.voiceChannelSvc.setServerDeafened(userId, isServerDeafened ?? false);
        });
    }

    // ── Create channel / category ─────────────────────────────────────────────
    protected openCreateChannel(categoryId: string | undefined): void {
        const position = categoryId
            ? this.categoryChannels(categoryId).length
            : this.uncategorizedChannels().length;
        this.createChannelModal?.open(categoryId, position);
    }

    protected openCreateCategory(): void {
        this.createCategoryModal?.open(this.localCategories().length);
    }
}
