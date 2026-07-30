import {Component, computed, DestroyRef, effect, HostListener, inject, input, signal, ViewChild} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {firstValueFrom} from 'rxjs';
import {NgClass} from '@angular/common';
import {Menu} from 'primeng/menu';
import {ContextMenu} from 'primeng/contextmenu';
import {Button} from 'primeng/button';
import {Tooltip} from 'primeng/tooltip';
import {Dialog} from 'primeng/dialog';
import {InputText} from 'primeng/inputtext';
import {MenuItem, PrimeTemplate} from 'primeng/api';
import {CategoryDto, ChannelDto, ChannelType, GuildDto,} from '../../../../dtos/response/guild.dto';
import {NavigationService} from '../../../main-page/navigation.service';
import {GuildService} from '../../../../services/guild.service';
import {VoiceChannelParticipant, VoiceChannelService} from '../../../../services/voice-channel.service';
import {CallContextMenuComponent} from '../../../../shared/call/call-context-menu/call-context-menu.component';
import {CallParticipantMenuData} from '../../../../shared/call/call.types';
import {ProfileService} from '../../../../services/profile.service';
import {GuildReadStateService} from '../../../../services/guild-read-state.service';
import {GuildSettingsModalComponent} from '../guild-settings-modal/guild-settings-modal.component';
import {ChannelSettingsModalComponent} from '../channel-settings-modal/channel-settings-modal.component';
import {CategorySettingsModalComponent} from '../category-settings-modal/category-settings-modal.component';
import {InviteType} from '../../../../dtos/response/invite.dto';
import {SelfGuildMemberDto} from '../../../../dtos/response/member.dto';
import {hasPermission, parsePermissions, Permissions} from '../../../../enums/permissions.enum';
import {
  GuildWebsocketService,
  WsCategoryCreated,
  WsCategoryDeleted,
  WsChannelCreated,
  WsChannelDeleted,
  WsChannelUpdated
} from '../../../../services/guild-websocket.service';
import {GuildVoiceService} from '../../../../services/guild-voice.service';
import {GuildUiActionsService} from '../../../../services/guild-ui-actions.service';
import {TranslateModule} from '@ngx-translate/core';
import {ChannelListDragService} from './channel-list-drag.service';
import {CreateChannelModalComponent} from './components/create-channel-modal/create-channel-modal.component';
import {CreateCategoryModalComponent} from './components/create-category-modal/create-category-modal.component';
import {ChannelListItemsComponent} from './components/channel-list-items/channel-list-items.component';
import {
  ChannelDropIndicatorComponent
} from './components/channel-drop-indicator/channel-drop-indicator.component';

@Component({
    selector: 'app-channel-list',
    providers: [ChannelListDragService],
    imports: [
        NgClass,
        Menu,
        ContextMenu,
        Button,
        Tooltip,
        Dialog,
        InputText,
        ChannelListItemsComponent,
        ChannelDropIndicatorComponent,
        GuildSettingsModalComponent,
        ChannelSettingsModalComponent,
        CategorySettingsModalComponent,
        CreateChannelModalComponent,
        CreateCategoryModalComponent,
        PrimeTemplate,
        CallContextMenuComponent,
        TranslateModule,
    ],
    templateUrl: './channel-list.component.html',
})
export class ChannelListComponent {
    guild = input.required<GuildDto>();
    // ── Context menu refs ─────────────────────────────────────────────────────
    @ViewChild('guildMenu') guildMenu!: Menu;
    @ViewChild('channelMenu') channelMenu!: Menu;
    @ViewChild('categoryMenu') categoryMenu!: Menu;
    @ViewChild('listMenu') listMenu!: ContextMenu;
    @ViewChild(ChannelSettingsModalComponent) channelSettingsModal?: ChannelSettingsModalComponent;
    @ViewChild(CategorySettingsModalComponent) categorySettingsModal?: CategorySettingsModalComponent;
    @ViewChild(CreateChannelModalComponent) createChannelModal?: CreateChannelModalComponent;
    @ViewChild(CreateCategoryModalComponent) createCategoryModal?: CreateCategoryModalComponent;
    protected readonly ChannelType = ChannelType;
    protected navService = inject(NavigationService);
    protected drag = inject(ChannelListDragService);
    private voiceChannelSvc = inject(VoiceChannelService);
    private profileService = inject(ProfileService);
    private readStateService = inject(GuildReadStateService);
    // ── Local mutable copies for optimistic updates ───────────────────────────
    protected localChannels = signal<ChannelDto[]>([]);
    protected localCategories = signal<CategoryDto[]>([]);
    // ── Computed channel groups (sorted by position) ──────────────────────────
    // Nested channels (text-channel threads and forum posts) arrive in the guild
    // payload alongside top-level channels but belong to their parent's own UI -
    // the thread panel or the forum post list - never the sidebar.
    protected uncategorizedChannels = computed(() =>
        this.localChannels()
            .filter(c => !c.categoryId && !c.parentChannelId)
            .sort((a, b) => a.position - b.position)
    );
    protected sortedCategories = computed(() =>
        [...this.localCategories()].sort((a, b) => a.position - b.position)
    );
    protected isWikiActive = computed(() => this.navService.wikiPanelGuildId() !== null);
    // ── Modal visibility ──────────────────────────────────────────────────────
    protected showGuildSettings = signal(false);
    protected showChannelSettings = signal(false);
    protected showCategorySettings = signal(false);
    // ── Quick invite dialog ───────────────────────────────────────────────────
    protected showInviteDialog = signal(false);
    protected inviteLink = signal('');
    protected inviteLoading = signal(false);
    protected inviteCopied = signal(false);
    // ── Create channel / category dialogs ─────────────────────────────────────
    protected showCreateChannel = signal(false);
    protected showCreateCategory = signal(false);

    // ── Drag delegates (HostListener must stay in component) ──────────────────
    protected contextChannel = signal<ChannelDto | null>(null);
    protected contextCategory = signal<CategoryDto | null>(null);
    // ── Guild header dropdown items ───────────────────────────────────────────
    protected guildMenuItems: MenuItem[] = [
        {
            label: 'Server Settings',
            icon: 'pi pi-cog',
            command: () => this.showGuildSettings.set(true),
        },
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
    ];
    // ── Voice participant context menu ────────────────────────────────────────
    protected participantMenu = signal<CallParticipantMenuData | null>(null);
    private guildService = inject(GuildService);
    private guildVoiceSvc = inject(GuildVoiceService);
    private guildUiActions = inject(GuildUiActionsService);
    private guildWsService = inject(GuildWebsocketService);
    private destroyRef = inject(DestroyRef);
    // ── Permission checking ───────────────────────────────────────────────────
    private ownMember = signal<SelfGuildMemberDto | null>(null);
    protected getSelfPermissions = computed(() => {
        const member = this.ownMember();
        const basePermissions = member?.permissions ?? '';
        const permissionString = member?.roleMembers.reduce((curr, m) => {
            if (!m.role.permissions) return curr;
            return curr === '' ? m.role.permissions : `${curr},${m.role.permissions}`;
        }, basePermissions);
        return parsePermissions(permissionString);
    });
    protected canReorder = computed(() => {
        const ownUserId = this.profileService.ownProfile()?.userId;
        if (ownUserId && ownUserId === this.guild().ownerId) return true;
        const member = this.ownMember();
        if (!member) return false;
        const perms = this.getSelfPermissions();
        return hasPermission(perms, Permissions.Superadmin) || hasPermission(perms, Permissions.ManageChannel);
    });
    protected isSuperadmin = computed(() => {
        const ownUserId = this.profileService.ownProfile()?.userId;
        if (ownUserId && ownUserId === this.guild().ownerId) return true;
        const m = this.ownMember();
        if (!m) return false;
        return hasPermission(parsePermissions(m.permissions), Permissions.Superadmin);
    });
    // ── Collapse state ────────────────────────────────────────────────────────
    private collapsedIds = signal(new Set<string>());
    private participantChannelId = signal<string | null>(null);

    constructor() {
        effect(() => {
            this.voiceChannelSvc.loadVoiceStatesForGuild(this.guild().channels, this.guild().id);
        });

        effect(() => {
            this.readStateService.loadForGuild(this.guild().id);
        });

        effect(() => {
            this.localChannels.set([...this.guild().channels]);
            this.localCategories.set([...this.guild().categories]);
        });

        effect(() => {
            const guildId = this.guild().id;
            this.guildService.getOwnMember(guildId).subscribe(m => this.ownMember.set(m));
        });

        this.drag.setup(() => this.guild().id, this.localChannels, this.localCategories);

        this.guildWsService.channelReorderedObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(dto => {
                if (dto.channels.length > 0) {
                    const posMap = new Map(dto.channels.map(c => [c.channelId, c.position]));
                    this.localChannels.update(channels =>
                        channels.map(c => posMap.has(c.id) ? {...c, position: posMap.get(c.id)!} : c)
                    );
                }
                if (dto.categories.length > 0) {
                    const catMap = new Map(dto.categories.map(c => [c.categoryId, c.position]));
                    this.localCategories.update(cats =>
                        cats.map(c => catMap.has(c.id) ? {...c, position: catMap.get(c.id)!} : c)
                    );
                }
            });

        this.guildWsService.channelCreatedObservable
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

        this.guildWsService.channelDeletedObservable
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

        this.guildWsService.channelUpdatedObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((e: WsChannelUpdated) => {
                if (e.guildId !== this.guild().id) return;
                this.guildService.getGuild(e.guildId).subscribe(g => {
                    const ch = g.channels.find(c => c.id === e.channelId);
                    if (!ch) return;
                    this.patchGuild({channels: this.guild().channels.map(c => c.id === ch.id ? ch : c)});
                });
            });

        this.guildWsService.categoryCreatedObservable
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

        this.guildWsService.categoryDeletedObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe((e: WsCategoryDeleted) => {
                if (e.guildId !== this.guild().id) return;
                this.patchGuild({
                    categories: this.guild().categories.filter(c => c.id !== e.categoryId),
                    channels: this.guild().channels.map(c => c.categoryId === e.categoryId ? {...c, categoryId: undefined} : c),
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
        this.patchGuild({channels: this.guild().channels.map(c => c.id === updated.id ? updated : c)});
    }

    protected onCategoryUpdated(updated: CategoryDto): void {
        this.patchGuild({categories: this.guild().categories.map(c => c.id === updated.id ? updated : c)});
    }

    protected categoryChannels(categoryId: string): ChannelDto[] {
        return this.localChannels()
            .filter(c => c.categoryId === categoryId && !c.parentChannelId)
            .sort((a, b) => a.position - b.position);
    }

    protected openWiki(): void {
        this.navService.openWiki(this.guild().id);
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
            this.voiceChannelSvc.joinChannel(channel, this.guild().name);
        }
        this.navService.mobileNavOpen.set(false);
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
                styleClass: 'text-rose-400',
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
                styleClass: 'text-rose-400',
                command: () => this.categorySettingsModal?.open(category, this.guild()),
            },
        ];
    }

    protected toggleGuildMenu(event: MouseEvent): void {
        this.guildMenu.toggle(event);
    }

    protected onChannelContextMenu(event: MouseEvent, channel: ChannelDto): void {
        event.preventDefault();
        event.stopPropagation();
        this.contextChannel.set(channel);
        this.channelMenu.model = this.buildChannelMenuItems(channel);
        this.channelMenu.show(event);
    }

    protected onCategoryContextMenu(event: MouseEvent, category: CategoryDto): void {
        event.preventDefault();
        event.stopPropagation();
        this.contextCategory.set(category);
        this.categoryMenu.model = this.buildCategoryMenuItems(category);
        this.categoryMenu.show(event);
    }

    protected onListContextMenu(event: MouseEvent): void {
        this.listMenu.show(event);
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

    protected onParticipantContextMenu(event: MouseEvent, p: VoiceChannelParticipant, channelId: string): void {
        event.preventDefault();
        event.stopPropagation();
        if (p.isLocal) return;
        const volume = Math.round(this.voiceChannelSvc.getUserVolume(p.userId) * 100);
        const x = Math.min(event.clientX, window.innerWidth - 236);
        const y = Math.min(event.clientY, window.innerHeight - 200);
        this.participantChannelId.set(channelId);
        this.participantMenu.set({x: Math.max(0, x), y: Math.max(0, y), participant: p, volume});
    }

    protected onParticipantVolumeChange(value: number): void {
        const menu = this.participantMenu();
        if (!menu) return;
        this.participantMenu.set({...menu, volume: value});
        this.voiceChannelSvc.setUserVolume(menu.participant.userId, value / 100);
    }

    protected async kickParticipant(): Promise<void> {
        const menu = this.participantMenu();
        if (!menu) return;
        this.participantMenu.set(null);
        await firstValueFrom(
            this.guildService.kickMemberByUserId(this.guild().id, menu.participant.userId)
        ).catch(() => {
        });
    }

    protected async banParticipant(): Promise<void> {
        const menu = this.participantMenu();
        if (!menu) return;
        this.participantMenu.set(null);
        await firstValueFrom(
            this.guildService.banMember(this.guild().id, {userId: menu.participant.userId})
        ).catch(() => {
        });
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
            this.guildVoiceSvc.serverDeafen(this.guild().id, channelId, userId, newState)
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
