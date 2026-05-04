import {Component, computed, effect, inject, input, signal, ViewChild} from '@angular/core';
import {NgClass} from '@angular/common';
import {FormsModule} from '@angular/forms';
import {Menu} from 'primeng/menu';
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
import {VoiceChannelService} from '../../../../services/voice-channel.service';
import {ProfileService} from '../../../../services/profile.service';
import {AppAvatarComponent} from '../../../../components/avatar/avatar.component';
import {GuildSettingsModalComponent} from '../guild-settings-modal/guild-settings-modal.component';
import {ChannelSettingsModalComponent} from '../channel-settings-modal/channel-settings-modal.component';
import {CategorySettingsModalComponent} from '../category-settings-modal/category-settings-modal.component';
import { InviteType } from '../../../../dtos/response/invite.dto';

@Component({
  selector: 'app-channel-list',
    imports: [
        NgClass,
        FormsModule,
        Menu,
        Button,
        Dialog,
        InputText,
        AppAvatarComponent,
        GuildSettingsModalComponent,
        ChannelSettingsModalComponent,
        CategorySettingsModalComponent,
        PrimeTemplate,
    ],
  templateUrl: './channel-list.component.html',
})
export class ChannelListComponent {
  guild = input.required<GuildDto>();

  protected readonly ChannelType = ChannelType;
  protected navService      = inject(NavigationService);
  protected voiceChannelSvc = inject(VoiceChannelService);
  private   guildService    = inject(GuildService);
  protected profileService  = inject(ProfileService);

  protected avatarUrl(userId: string): string | undefined {
    return this.profileService.getCachedByUserId(userId)?.avatarUrl;
  }

  constructor() {
    // Seed mock voice participants whenever the guild changes
    effect(() => {
      this.voiceChannelSvc.seedMockParticipants(this.guild().channels);
    });
  }

  // ── Collapse state ────────────────────────────────────────────────────────
  private collapsedIds = signal(new Set<string>());

  // ── Computed channel groups ───────────────────────────────────────────────
  protected uncategorizedText = computed(() =>
    this.guild().channels.filter(c => !c.categoryId && c.type === ChannelType.Text)
  );

  protected uncategorizedVoice = computed(() =>
    this.guild().channels.filter(c => !c.categoryId && c.type === ChannelType.Voice)
  );

  protected categoryChannels(categoryId: string): ChannelDto[] {
    return this.guild().channels.filter(c => c.categoryId === categoryId);
  }

  protected isActive(channel: ChannelDto): boolean {
    const view = this.navService.mainView();
    return view.type === 'channel' && view.channel.id === channel.id;
  }

  protected isJoinedVoice(channel: ChannelDto): boolean {
    return this.voiceChannelSvc.joinedChannelId() === channel.id;
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

  // ── Modal visibility ──────────────────────────────────────────────────────
  protected showGuildSettings = signal(false);
  protected showChannelSettings = signal(false);
  protected showCategorySettings = signal(false);

  // ── Quick invite dialog ───────────────────────────────────────────────────
  protected showInviteDialog = signal(false);
  protected inviteLink = signal('');
  protected inviteLoading = signal(false);
  protected inviteCopied = signal(false);

  // ── Create channel dialog ─────────────────────────────────────────────────
  protected showCreateChannel = signal(false);
  protected createChannelName = signal('');
  protected createChannelType = signal<ChannelType>(ChannelType.Text);
  protected createChannelCategory = signal<string | undefined>(undefined);
  protected createChannelCreating = signal(false);

  // ── Create category dialog ────────────────────────────────────────────────
  protected showCreateCategory = signal(false);
  protected createCategoryName = signal('');
  protected createCategoryCreating = signal(false);

  // ── Context menu refs ─────────────────────────────────────────────────────
  @ViewChild('guildMenu') guildMenu!: Menu;
  @ViewChild('channelMenu') channelMenu!: Menu;
  @ViewChild('categoryMenu') categoryMenu!: Menu;

  protected contextChannel = signal<ChannelDto | null>(null);
  protected contextCategory = signal<CategoryDto | null>(null);

  // ── Guild header dropdown items ───────────────────────────────────────────
  protected guildMenuItems: MenuItem[] = [
    {
      label: 'Server Settings',
      icon: 'pi pi-cog',
      command: () => this.showGuildSettings.set(true),
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

  // ── Channel context menu items (rebuilt per channel) ──────────────────────
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

  // ── Category context menu items ───────────────────────────────────────────
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

  // ── Modal references ──────────────────────────────────────────────────────
  @ViewChild(ChannelSettingsModalComponent) channelSettingsModal?: ChannelSettingsModalComponent;
  @ViewChild(CategorySettingsModalComponent) categorySettingsModal?: CategorySettingsModalComponent;

  // ── Guild header dropdown ─────────────────────────────────────────────────
  protected toggleGuildMenu(event: MouseEvent): void {
    this.guildMenu.toggle(event);
  }

  // ── Channel right-click ───────────────────────────────────────────────────
  protected onChannelContextMenu(event: MouseEvent, channel: ChannelDto): void {
    event.preventDefault();
    this.contextChannel.set(channel);
    this.channelMenu.model = this.buildChannelMenuItems(channel);
    this.channelMenu.show(event);
  }

  // ── Category right-click ──────────────────────────────────────────────────
  protected onCategoryContextMenu(event: MouseEvent, category: CategoryDto): void {
    event.preventDefault();
    this.contextCategory.set(category);
    this.categoryMenu.model = this.buildCategoryMenuItems(category);
    this.categoryMenu.show(event);
  }

  // ── Quick invite ──────────────────────────────────────────────────────────
  protected quickCreateInvite(): void {
    this.inviteLink.set('');
    this.inviteCopied.set(false);
    this.inviteLoading.set(true);
    this.showInviteDialog.set(true);
    this.guildService.createInvite({type: InviteType.Permanent}, this.guild().id).subscribe({
      next: invite => {
        const link = `https://venta.gg/invite/${invite.id}`;
        this.inviteLink.set(link);
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
    this.guildService.createChannel({
      guildId: this.guild().id,
      name: this.createChannelName().trim(),
      type: this.createChannelType(),
      categoryId: this.createChannelCategory(),
    }).subscribe({
      next: () => {
        this.showCreateChannel.set(false);
        this.createChannelCreating.set(false);
        // Ideally refresh guild; for now close
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
    }).subscribe({
      next: () => {
        this.showCreateCategory.set(false);
        this.createCategoryCreating.set(false);
      },
      error: () => this.createCategoryCreating.set(false),
    });
  }
}
