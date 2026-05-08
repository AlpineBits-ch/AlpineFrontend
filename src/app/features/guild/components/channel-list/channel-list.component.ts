import {Component, computed, DestroyRef, effect, HostListener, inject, input, signal, ViewChild} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {firstValueFrom} from 'rxjs';
import {NgClass} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {Menu} from 'primeng/menu';
import {ContextMenu} from 'primeng/contextmenu';
import {Button} from 'primeng/button';
import {Dialog} from 'primeng/dialog';
import {InputText} from 'primeng/inputtext';
import {MenuItem, PrimeTemplate} from 'primeng/api';
import {
  CategoryDto,
  ChannelDto,
  ChannelType,
  GuildDto,
} from '../../../../dtos/response/guild.dto';
import {NavigationService} from '../../../main-page/navigation.service';
import {GuildService} from '../../../../services/guild.service';
import {VoiceChannelParticipant, VoiceChannelService} from '../../../../services/voice-channel.service';
import {VoiceChannelContextMenuComponent, ParticipantMenuData} from '../voice-channel/voice-channel-context-menu.component';
import {ProfileService} from '../../../../services/profile.service';
import {GuildReadStateService} from '../../../../services/guild-read-state.service';
import {AppAvatarComponent} from '../../../../components/avatar/avatar.component';
import {GuildSettingsModalComponent} from '../guild-settings-modal/guild-settings-modal.component';
import {ChannelSettingsModalComponent} from '../channel-settings-modal/channel-settings-modal.component';
import {CategorySettingsModalComponent} from '../category-settings-modal/category-settings-modal.component';
import {InviteType} from '../../../../dtos/response/invite.dto';
import {GuildMemberDto, SelfGuildMemberDto} from '../../../../dtos/response/member.dto';
import {hasPermission, parsePermissions, Permissions} from '../../../../enums/permissions.enum';
import {ReorderChannesDto} from '../../../../dtos/request/reorder-channel.dto';
import {GuildWebsocketService, WsChannelCreated, WsChannelDeleted, WsCategoryCreated, WsCategoryDeleted} from '../../../../services/guild-websocket.service';
import {GuildVoiceService} from '../../../../services/guild-voice.service';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';

@Component({
  selector: 'app-channel-list',
  imports: [
    NgClass,
    FormsModule,
    Menu,
    ContextMenu,
    Button,
    Dialog,
    InputText,
    AppAvatarComponent,
    GuildSettingsModalComponent,
    ChannelSettingsModalComponent,
    CategorySettingsModalComponent,
    PrimeTemplate,
    VoiceChannelContextMenuComponent,
  ],
  templateUrl: './channel-list.component.html',
})
export class ChannelListComponent {
  guild = input.required<GuildDto>();

  protected readonly ChannelType = ChannelType;
  protected navService       = inject(NavigationService);
  protected voiceChannelSvc  = inject(VoiceChannelService);
  private   guildService     = inject(GuildService);
  private   guildVoiceSvc    = inject(GuildVoiceService);
  protected profileService   = inject(ProfileService);
  protected readStateService = inject(GuildReadStateService);
  private   guildWsService   = inject(GuildWebsocketService);
  private   destroyRef       = inject(DestroyRef);

  protected avatarUrl(userId: string): string | undefined {
    return this.profileService.getCachedByUserId(userId)?.avatarUrl;
  }

  protected onGuildUpdated(updated: GuildDto): void {
    this.navService.updateCurrentGuild(updated);
  }

  // ── Permission checking ───────────────────────────────────────────────────
  private ownMember = signal<SelfGuildMemberDto | null>(null);

  protected getSelfPermissions = computed(() => {
    const member = this.ownMember();

    let basePermissions = member?.permissions ?? '';


    const permissionString = member?.roleMembers.reduce((curr, m) => {
      if(!m.role.permissions) return curr;

      if(curr === '') return m.role.permissions;

      return `${curr},${m.role.permissions}`;
    }, basePermissions);


    console.log('accumulated perm string', permissionString)
    return parsePermissions(permissionString);

  });

  protected canReorder = computed(() => {
    const perms = this.getSelfPermissions();

    const ownUserId = this.profileService.ownProfile()?.userId;
    if (ownUserId && ownUserId === this.guild().ownerId) return true;
    const member = this.ownMember();
    if (!member) return false;



    return hasPermission(perms, Permissions.Superadmin) || hasPermission(perms, Permissions.ManageChannel);
  });

  protected isSuperadmin = computed(() => {
    const ownUserId = this.profileService.ownProfile()?.userId;
    if (ownUserId && ownUserId === this.guild().ownerId) return true;
    const m = this.ownMember();
    if (!m) return false;
    return hasPermission(parsePermissions(m.permissions), Permissions.Superadmin);
  });

  // ── Local mutable copies for optimistic updates ───────────────────────────
  protected localChannels   = signal<ChannelDto[]>([]);
  protected localCategories = signal<CategoryDto[]>([]);

  constructor() {
    effect(() => {
      this.voiceChannelSvc.loadVoiceStatesForGuild(this.guild().channels, this.guild().id);
    });

    effect(() => {
      this.readStateService.loadForGuild(this.guild().id);
    });

    // Sync local copies from guild input (resets when server sends fresh data)
    effect(() => {
      this.localChannels.set([...this.guild().channels]);
      this.localCategories.set([...this.guild().categories]);
    });

    // Load own member to determine reorder permissions
    effect(() => {
      const guildId = this.guild().id;
      this.guildService.getOwnMember(guildId).subscribe(m => this.ownMember.set(m));
    });

    // Apply position updates from ChannelReordered WebSocket event (for other users)
    this.guildWsService.channelReorderedObservable
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(dto => {
        if (dto.channels.length > 0) {
          const posMap = new Map(dto.channels.map(c => [c.channelId, c.position]));
          this.localChannels.update(channels =>
            channels.map(c => posMap.has(c.id) ? { ...c, position: posMap.get(c.id)! } : c)
          );
        }
        if (dto.categories.length > 0) {
          const catMap = new Map(dto.categories.map(c => [c.categoryId, c.position]));
          this.localCategories.update(cats =>
            cats.map(c => catMap.has(c.id) ? { ...c, position: catMap.get(c.id)! } : c)
          );
        }
      });

    this.guildWsService.channelCreatedObservable
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((e: WsChannelCreated) => {
        if (e.guildId !== this.guild().id) return;
        this.guildService.getGuild(e.guildId).subscribe(g => {
          const ch = g.channels.find(c => c.id === e.channelId);
          if (ch && !this.localChannels().some(c => c.id === e.channelId)) {
            this.localChannels.update(chs => [...chs, ch]);
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

        this.localChannels.update(chs => chs.filter(c => c.id !== e.channelId));

        const view = this.navService.mainView();
        if (view.type === 'channel' && view.channel.id === e.channelId) {
          const firstText = this.localChannels().find(c => c.type === ChannelType.Text);
          if (firstText) {
            this.navService.openChannel(firstText);
          } else {
            this.navService.showHome();
          }
        }
      });

    this.guildWsService.categoryCreatedObservable
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((e: WsCategoryCreated) => {
        if (e.guildId !== this.guild().id) return;
        this.guildService.getGuild(e.guildId).subscribe(g => {
          const cat = g.categories.find(c => c.id === e.categoryId);
          if (cat && !this.localCategories().some(c => c.id === e.categoryId)) {
            this.localCategories.update(cats => [...cats, cat]);
          }
        });
      });

    this.guildWsService.categoryDeletedObservable
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((e: WsCategoryDeleted) => {
        if (e.guildId !== this.guild().id) return;
        this.localCategories.update(cats => cats.filter(c => c.id !== e.categoryId));
        this.localChannels.update(chs =>
          chs.map(c => c.categoryId === e.categoryId ? { ...c, categoryId: undefined } : c)
        );
      });
  }

  // ── Collapse state ────────────────────────────────────────────────────────
  private collapsedIds = signal(new Set<string>());

  // ── Computed channel groups (sorted by position) ──────────────────────────
  protected uncategorizedText = computed(() =>
    this.localChannels()
      .filter(c => !c.categoryId && c.type === ChannelType.Text)
      .sort((a, b) => a.position - b.position)
  );

  protected uncategorizedVoice = computed(() =>
    this.localChannels()
      .filter(c => !c.categoryId && c.type === ChannelType.Voice)
      .sort((a, b) => a.position - b.position)
  );

  protected uncategorizedChannels = computed(() =>
    this.localChannels()
      .filter(c => !c.categoryId)
      .sort((a, b) => a.position - b.position)
  );

  protected sortedCategories = computed(() =>
    [...this.localCategories()].sort((a, b) => a.position - b.position)
  );

  protected categoryChannels(categoryId: string): ChannelDto[] {
    return this.localChannels()
      .filter(c => c.categoryId === categoryId)
      .sort((a, b) => a.position - b.position);
  }

  protected isActive(channel: ChannelDto): boolean {
    const view = this.navService.mainView();
    return view.type === 'channel' && view.channel.id === channel.id;
  }

  protected isJoinedVoice(channel: ChannelDto): boolean {
    return this.voiceChannelSvc.joinedChannelId() === channel.id;
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

  // ── Drag state ────────────────────────────────────────────────────────────
  private dragging: { type: 'category' | 'channel'; id: string; sourceCategoryId: string | null } | null = null;
  protected dropTargetId = signal<string | null>(null);
  protected dropPos      = signal<'before' | 'after'>('after');

  // WebView2 (Tauri/Windows) integrates with Windows OLE drag-and-drop and requires
  // dropEffect = 'move' to be set on every dragover/dragenter event — calling only
  // preventDefault() is not enough and results in an immediate red "no-drop" cursor.
  // These document-level handlers cover all elements including gaps between items.
  @HostListener('document:dragover', ['$event'])
  protected onGlobalDragOver(event: DragEvent): void {
    if (!this.dragging) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }

  @HostListener('document:dragenter', ['$event'])
  protected onGlobalDragEnter(event: DragEvent): void {
    if (!this.dragging) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }

  protected onCategoryDragStart(event: DragEvent, category: CategoryDto): void {
    this.dragging = { type: 'category', id: category.id, sourceCategoryId: null };
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', category.id);
    }
  }

  protected onChannelDragStart(event: DragEvent, channel: ChannelDto): void {
    this.dragging = { type: 'channel', id: channel.id, sourceCategoryId: channel.categoryId ?? null };
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', channel.id);
    }
  }

  // Prevent browser default on drop (e.g. navigation). Actual logic runs in onDragEnd.
  @HostListener('document:drop', ['$event'])
  protected onGlobalDrop(event: DragEvent): void {
    event.preventDefault();
  }

  // All drop logic lives here so it's driven by the indicator position (dropTargetId/dropPos),
  // not by whichever physical DOM element the mouse happened to be over on release.
  // This also handles WebView2 where the drop event may not fire at all.
  protected onDragEnd(event: DragEvent): void {
    const dragging = this.dragging;
    const targetId  = this.dropTargetId();
    const pos       = this.dropPos();
    this.clearDragState();

    if (!dragging || !targetId) return;

    const targetChannel = this.localChannels().find(c => c.id === targetId);
    if (targetChannel) {
      if (dragging.type !== 'channel' || dragging.id === targetChannel.id) return;
      const targetCategoryId = targetChannel.categoryId ?? null;
      const categoryChanged  = dragging.sourceCategoryId !== targetCategoryId;
      if (categoryChanged) {
        this.localChannels.update(chs =>
          chs.map(c => c.id === dragging.id ? { ...c, categoryId: targetCategoryId ?? undefined } : c)
        );
      }
      this.reorderChannelsInSection(dragging.id, targetCategoryId, targetChannel.id, pos, categoryChanged ? targetCategoryId : undefined);
      return;
    }

    const targetCategory = this.localCategories().find(c => c.id === targetId);
    if (targetCategory) {
      if (dragging.type === 'category' && dragging.id !== targetCategory.id) {
        this.reorderCategoryAfterDrop(dragging.id, targetCategory.id, pos);
      } else if (dragging.type === 'channel') {
        if (pos === 'before') {
          // Blue line before a category header = move channel to uncategorized section
          if (dragging.sourceCategoryId !== null) {
            this.localChannels.update(chs =>
              chs.map(c => c.id === dragging.id ? { ...c, categoryId: undefined } : c)
            );
            this.appendChannelToSection(dragging.id, null, null);
          }
        } else if (dragging.sourceCategoryId !== targetCategory.id) {
          // Blue line after/on a category header = move channel into that category
          this.localChannels.update(chs =>
            chs.map(c => c.id === dragging.id ? { ...c, categoryId: targetCategory.id } : c)
          );
          this.appendChannelToSection(dragging.id, targetCategory.id, targetCategory.id);
        }
      }
    }
  }

  protected onItemDragOver(event: DragEvent, targetId: string): void {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    if (!this.dragging || this.dragging.id === targetId) return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    this.dropTargetId.set(targetId);
    this.dropPos.set(event.clientY < rect.top + rect.height / 2 ? 'before' : 'after');
  }

  private reorderChannelsInSection(
    draggedId: string,
    categoryId: string | null,
    targetId: string,
    pos: 'before' | 'after',
    newCategoryId?: string | null,
  ): void {
    const sectionChannels = categoryId
      ? this.categoryChannels(categoryId)
      : [...this.uncategorizedText(), ...this.uncategorizedVoice()];

    const dragged = this.localChannels().find(c => c.id === draggedId);
    if (!dragged) return;

    const sorted = sectionChannels.filter(c => c.id !== draggedId);
    const targetIndex = sorted.findIndex(c => c.id === targetId);
    const insertAt = targetIndex === -1
      ? sorted.length
      : pos === 'before' ? targetIndex : targetIndex + 1;
    sorted.splice(insertAt, 0, dragged);

    const newPositions = new Map(sorted.map((c, i) => [c.id, i]));
    this.localChannels.update(chs =>
      chs.map(c => newPositions.has(c.id) ? { ...c, position: newPositions.get(c.id)! } : c)
    );

    this.guildService.reorderChannels(this.guild().id, {
      categories: [],
      channels: sorted.map((c, i) => ({
        channelId: c.id,
        position: i,
        ...(c.id === draggedId && newCategoryId !== undefined ? { categoryId: newCategoryId } : {}),
      })),
    }).subscribe();
  }

  private appendChannelToSection(channelId: string, categoryId: string | null, newCategoryId?: string | null): void {
    const sectionChannels = categoryId
      ? this.categoryChannels(categoryId)
      : [...this.uncategorizedText(), ...this.uncategorizedVoice()];

    const dragged = this.localChannels().find(c => c.id === channelId);
    if (!dragged) return;

    const sorted = [...sectionChannels.filter(c => c.id !== channelId), dragged];
    const newPositions = new Map(sorted.map((c, i) => [c.id, i]));
    this.localChannels.update(chs =>
      chs.map(c => newPositions.has(c.id) ? { ...c, position: newPositions.get(c.id)! } : c)
    );

    this.guildService.reorderChannels(this.guild().id, {
      categories: [],
      channels: sorted.map((c, i) => ({
        channelId: c.id,
        position: i,
        ...(c.id === channelId && newCategoryId !== undefined ? { categoryId: newCategoryId } : {}),
      })),
    }).subscribe();
  }

  private reorderCategoryAfterDrop(draggedId: string, targetId: string, pos: 'before' | 'after'): void {
    const sorted = [...this.sortedCategories()];
    const fromIndex = sorted.findIndex(c => c.id === draggedId);
    if (fromIndex === -1) return;

    const [dragged] = sorted.splice(fromIndex, 1);
    const newTargetIndex = sorted.findIndex(c => c.id === targetId);
    if (newTargetIndex === -1) return;

    sorted.splice(pos === 'before' ? newTargetIndex : newTargetIndex + 1, 0, dragged);

    const newPositions = new Map(sorted.map((c, i) => [c.id, i]));
    this.localCategories.update(cats =>
      cats.map(c => newPositions.has(c.id) ? { ...c, position: newPositions.get(c.id)! } : c)
    );

    this.guildService.reorderChannels(this.guild().id, {
      categories: sorted.map((c, i) => ({ categoryId: c.id, position: i })),
      channels: [],
    }).subscribe();
  }

  private clearDragState(): void {
    this.dragging = null;
    this.dropTargetId.set(null);
    this.dropPos.set('after');
  }

  // ── Modal visibility ──────────────────────────────────────────────────────
  protected showGuildSettings   = signal(false);
  protected showChannelSettings = signal(false);
  protected showCategorySettings = signal(false);

  // ── Quick invite dialog ───────────────────────────────────────────────────
  protected showInviteDialog = signal(false);
  protected inviteLink       = signal('');
  protected inviteLoading    = signal(false);
  protected inviteCopied     = signal(false);

  // ── Create channel dialog ─────────────────────────────────────────────────
  protected showCreateChannel      = signal(false);
  protected createChannelName      = signal('');
  protected createChannelType      = signal<ChannelType>(ChannelType.Text);
  protected createChannelCategory  = signal<string | undefined>(undefined);
  protected createChannelCreating  = signal(false);

  // ── Create category dialog ────────────────────────────────────────────────
  protected showCreateCategory    = signal(false);
  protected createCategoryName    = signal('');
  protected createCategoryCreating = signal(false);

  // ── Context menu refs ─────────────────────────────────────────────────────
  @ViewChild('guildMenu')    guildMenu!: Menu;
  @ViewChild('channelMenu')  channelMenu!: Menu;
  @ViewChild('categoryMenu') categoryMenu!: Menu;
  @ViewChild('listMenu')     listMenu!: ContextMenu;

  protected contextChannel  = signal<ChannelDto | null>(null);
  protected contextCategory = signal<CategoryDto | null>(null);

  // ── Guild header dropdown items ───────────────────────────────────────────
  protected guildMenuItems: MenuItem[] = [
    {
      label: 'Server Settings',
      icon: 'pi pi-cog',
      command: () => this.showGuildSettings.set(true),
    },
    { separator: true },
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
    { separator: true },
    {
      label: 'Create Invite',
      icon: 'pi pi-link',
      command: () => this.quickCreateInvite(),
    },
  ];

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
      { separator: true },
      {
        label: 'Copy Channel ID',
        icon: 'pi pi-copy',
        command: () => navigator.clipboard.writeText(channel.id),
      },
      { separator: true },
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
      { separator: true },
      {
        label: 'Delete Category',
        icon: 'pi pi-trash',
        styleClass: 'text-rose-400',
        command: () => this.categorySettingsModal?.open(category, this.guild()),
      },
    ];
  }

  @ViewChild(ChannelSettingsModalComponent) channelSettingsModal?: ChannelSettingsModalComponent;
  @ViewChild(CategorySettingsModalComponent) categorySettingsModal?: CategorySettingsModalComponent;

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
    this.guildService.createInvite({ type: InviteType.Permanent }, this.guild().id).subscribe({
      next: invite => {
        this.inviteLink.set(`https://venta.gg/invite/${invite.id}`);
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

  // ── Voice participant context menu ────────────────────────────────────────
  protected participantMenu      = signal<ParticipantMenuData | null>(null);
  private   participantChannelId = signal<string | null>(null);

  protected onParticipantContextMenu(event: MouseEvent, p: VoiceChannelParticipant, channelId: string): void {
    event.preventDefault();
    event.stopPropagation();
    if (p.isLocal) return;
    const volume = Math.round(this.voiceChannelSvc.getUserVolume(p.userId) * 100);
    const x = Math.min(event.clientX, window.innerWidth  - 236);
    const y = Math.min(event.clientY, window.innerHeight - 200);
    this.participantChannelId.set(channelId);
    this.participantMenu.set({ x: Math.max(0, x), y: Math.max(0, y), participant: p, volume });
  }

  protected onParticipantVolumeChange(value: number): void {
    const menu = this.participantMenu();
    if (!menu) return;
    this.participantMenu.set({ ...menu, volume: value });
    this.voiceChannelSvc.setUserVolume(menu.participant.userId, value / 100);
  }

  protected async kickParticipant(): Promise<void> {
    const menu = this.participantMenu();
    if (!menu) return;
    this.participantMenu.set(null);
    await firstValueFrom(
      this.guildService.kickMemberByUserId(this.guild().id, menu.participant.userId)
    ).catch(() => {});
  }

  protected async banParticipant(): Promise<void> {
    const menu = this.participantMenu();
    if (!menu) return;
    this.participantMenu.set(null);
    await firstValueFrom(
      this.guildService.banMemberByUserId(this.guild().id, menu.participant.userId)
    ).catch(() => {});
  }

  protected async toggleParticipantServerDeafen(): Promise<void> {
    const menu = this.participantMenu();
    const channelId = this.participantChannelId();
    if (!menu || !channelId) return;
    const { userId, isServerDeafened } = menu.participant;
    const newState = !isServerDeafened;
    this.participantMenu.set({ ...menu, participant: { ...menu.participant, isServerDeafened: newState } });
    this.voiceChannelSvc.setServerDeafened(userId, newState);
    await firstValueFrom(
      this.guildVoiceSvc.serverDeafen(this.guild().id, channelId, userId, newState)
    ).catch(() => {
      this.voiceChannelSvc.setServerDeafened(userId, isServerDeafened);
    });
  }

  // ── Create channel ────────────────────────────────────────────────────────
  protected openCreateChannel(categoryId: string | undefined): void {
    this.createChannelName.set('');
    this.createChannelType.set(ChannelType.Text);
    this.createChannelCategory.set(categoryId);
    this.showCreateChannel.set(true);
  }

  protected submitCreateChannel(): void {
    if (this.createChannelCreating() || !this.createChannelName().trim()) return;
    this.createChannelCreating.set(true);
    const categoryId = this.createChannelCategory();
    const position = categoryId
      ? this.categoryChannels(categoryId).length
      : this.localChannels().filter(c => !c.categoryId).length;
    this.guildService.createChannel({
      guildId: this.guild().id,
      name: this.createChannelName().trim(),
      type: this.createChannelType(),
      categoryId,
      position,
    }).subscribe({
      next: () => {
        this.showCreateChannel.set(false);
        this.createChannelCreating.set(false);
      },
      error: () => this.createChannelCreating.set(false),
    });
  }

  // ── Create category ───────────────────────────────────────────────────────
  protected openCreateCategory(): void {
    this.createCategoryName.set('');
    this.showCreateCategory.set(true);
  }

  protected submitCreateCategory(): void {
    if (this.createCategoryCreating() || !this.createCategoryName().trim()) return;
    this.createCategoryCreating.set(true);
    this.guildService.createCategory({
      guildId: this.guild().id,
      name: this.createCategoryName().trim(),
      position: this.localCategories().length,
    }).subscribe({
      next: () => {
        this.showCreateCategory.set(false);
        this.createCategoryCreating.set(false);
      },
      error: () => this.createCategoryCreating.set(false),
    });
  }
}
