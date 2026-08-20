import {
    ChangeDetectionStrategy,
    Component,
    computed,
    effect,
    inject,
    input,
    OnDestroy,
    signal,
    untracked,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {TranslateModule, TranslateService} from '@ngx-translate/core';
import {Button} from 'primeng/button';
import {InputText} from 'primeng/inputtext';
import {Textarea} from 'primeng/textarea';
import {Dialog} from 'primeng/dialog';
import {Menu} from 'primeng/menu';
import {Tooltip} from 'primeng/tooltip';
import {MenuItem, PrimeTemplate} from 'primeng/api';
import {ChannelDto, ChannelType} from '../../../../dtos/response/guild.dto';
import {
    FORUM_LIMITS,
    ForumLayout,
    ForumPost,
    ForumSortOrder,
    ForumTag,
} from '../../../../dtos/response/forum.dto';
import {GuildService} from '../../../../services/guild.service';
import {OwnMemberRevisionService} from '../../../../services/own-member-revision.service';
import {ForumService} from '../../../../services/forum.service';
import {ForumStateService} from '../../../../services/forum-state.service';
import {ForumPostListService} from '../../../../services/forum-post-list.service';
import {GuildEmojiStore} from '../../../../stores/guild-emoji.store';
import {NavigationService} from '../../../main-page/navigation.service';
import {ToastService} from '../../../../services/toast.service';
import {ProfileService} from '../../../../services/profile.service';
import {SelfGuildMemberDto} from '../../../../dtos/response/member.dto';
import {effectiveGuildPermissions} from '../../guild-permissions';
import {hasPermission, Permissions} from '../../../../enums/permissions.enum';
import {TagChipComponent} from '../../../../components/tag-chip/tag-chip.component';
import {ForumTagPickerComponent} from './forum-tag-picker.component';
import {ForumPostCardComponent, PostAction} from './forum-post-card.component';
import {channelIcon} from '../../channel-types';

/** A forum's post list: filter/sort toolbar, tag filter bar, posts, create-post dialog. Mounted full-width and again compact beside an open post; both share one list via ForumPostListService, so switching between them neither refetches nor flashes a spinner. */
@Component({
    selector: 'app-forum-post-list',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        Button,
        InputText,
        Textarea,
        Dialog,
        Menu,
        Tooltip,
        FormsModule,
        PrimeTemplate,
        TranslateModule,
        TagChipComponent,
        ForumTagPickerComponent,
        ForumPostCardComponent,
    ],
    templateUrl: './forum-post-list.component.html',
    // The list scrolls internally at every mount point, so the host has to be a sized flex item rather than inheriting whatever the mount site happens to be.
    host: {class: 'flex flex-col flex-1 min-h-0'},
})
export class ForumPostListComponent implements OnDestroy {
    readonly forum = input.required<ChannelDto>();
    /** Narrow-pane mode: no layout toggle, and the list layout is forced; see effectiveLayout. */
    readonly compact = input(false);

    protected readonly ForumLayout = ForumLayout;
    protected readonly maxTags = FORUM_LIMITS.tagsPerPost;

    // ── Create dialog ────────────────────────────────────────────────────────
    protected readonly showCreateDialog = signal(false);
    protected readonly createName = signal('');
    protected readonly createContent = signal('');
    protected readonly createTagIds = signal<string[]>([]);
    protected readonly creating = signal(false);
    protected readonly createTagError = signal(false);

    protected navService = inject(NavigationService);
    protected forumState = inject(ForumStateService);
    private postList = inject(ForumPostListService);
    private guildService = inject(GuildService);
    private ownMemberRevision = inject(OwnMemberRevisionService);
    private forumService = inject(ForumService);
    private emojiStore = inject(GuildEmojiStore);
    private profileService = inject(ProfileService);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);

    private readonly ownMember = signal<SelfGuildMemberDto | null>(null);

    /** This instance's claim on "the forum on screen"; handed back on destroy. */
    private activeClaim = 0;

    /** Ticked so the cards' relative timestamps age without each pipe reading the clock. */
    protected readonly nowTick = signal(0);
    private tickIntervalId = setInterval(() => this.nowTick.update(n => n + 1), 60_000);

    protected readonly isMedia = computed(() => this.forum().type === ChannelType.Media);
    /** From the shared table, so Forum and Media never drift from the rest of the app. */
    protected readonly icon = computed(() => channelIcon(this.forum().type));

    // ── Post list. All of it is held per forum in ForumPostListService. ───────
    protected readonly posts = computed(() => this.postList.stateFor(this.forum().id).posts);
    protected readonly loading = computed(() => this.postList.stateFor(this.forum().id).loading);
    protected readonly loadingMore = computed(() => this.postList.stateFor(this.forum().id).loadingMore);
    protected readonly nextCursor = computed(() => this.postList.stateFor(this.forum().id).nextCursor);
    protected readonly hasLoaded = computed(() => this.postList.stateFor(this.forum().id).hasLoaded);
    protected readonly selectedTagIds = computed(
        () => this.postList.stateFor(this.forum().id).selectedTagIds,
    );
    protected readonly showArchived = computed(() => this.postList.stateFor(this.forum().id).showArchived);

    protected readonly tags = computed(() => this.forumState.tagsFor(this.forum().id));
    protected readonly config = computed(() => this.forumState.configFor(this.forum().id));
    protected readonly layout = computed(() => this.forumState.layoutFor(this.forum().id));
    protected readonly sortOrder = computed(() => this.forumState.sortFor(this.forum().id));
    protected readonly requireTag = computed(() => this.config()?.requireTag ?? false);

    /** In the narrow pane a Gallery grid is a one-column grid with wasted gutters, so compact always renders as a list, without writing to ForumStateService so the user's stored Gallery preference survives in the full-width view. */
    protected readonly effectiveLayout = computed(() => (this.compact() ? ForumLayout.List : this.layout()));

    /** The post currently open in the main view, highlighted in the pane. */
    protected readonly openPostId = computed(() => {
        const view = this.navService.mainView();
        return view.type === 'channel' ? view.channel.id : null;
    });

    /** Guild emoji id → presigned url, for tags whose emoji is a custom guild one. */
    protected readonly emojiUrls = computed(() => {
        const map: Record<string, string> = {};
        for (const emoji of this.emojiStore.getEmojis(this.forum().guildId)) {
            map[emoji.id] = emoji.imageUrl;
        }
        return map;
    });

    private readonly permissions = computed(() => effectiveGuildPermissions(this.ownMember()));

    private readonly isOwner = computed(() => {
        const ws = this.navService.workspace();
        const ownUserId = this.profileService.ownProfile()?.userId;
        return (
            ws.type === 'server' &&
            ws.guild.id === this.forum().guildId &&
            !!ownUserId &&
            ownUserId === ws.guild.ownerId
        );
    });

    /** Owner first: SelfGuildMemberDto.permissions doesn't reliably carry Superadmin for them. */
    private can = (permission: bigint) =>
        this.isOwner() ||
        hasPermission(this.permissions(), Permissions.Superadmin) ||
        hasPermission(this.permissions(), permission);

    protected readonly canCreatePost = computed(() => this.can(Permissions.CreateThreads));
    protected readonly canModerate = computed(() => this.can(Permissions.ManageAnyThread));
    /** Gate for applying moderated tags: the server accepts either bit. */
    protected readonly canUseModeratedTags = computed(
        () => this.can(Permissions.ManageAnyThread) || this.can(Permissions.ManageChannel),
    );

    protected readonly sortMenuItems = computed<MenuItem[]>(() => [
        {
            label: this.translate.instant('FORUM.SORT_ACTIVITY'),
            icon: this.sortOrder() === ForumSortOrder.LatestActivity ? 'pi pi-check' : 'pi pi-fw',
            command: () => this.setSort(ForumSortOrder.LatestActivity),
        },
        {
            label: this.translate.instant('FORUM.SORT_CREATED'),
            icon: this.sortOrder() === ForumSortOrder.CreationDate ? 'pi pi-check' : 'pi pi-fw',
            command: () => this.setSort(ForumSortOrder.CreationDate),
        },
    ]);

    constructor() {
        effect(() => {
            const forumId = this.forum().id;
            const guildId = this.forum().guildId;
            untracked(() => {
                this.forumState.loadFor(forumId);
                this.emojiStore.ensureLoaded(guildId);
                // Only the forum on screen reloads on a post created in it; claim it, and release that claim again on destroy.
                this.activeClaim = this.postList.setActiveForum(forumId);
                // A list already fetched is reused as-is, letting a second mount point open over the same forum without refetching; it only catches up on a post created there while the user was elsewhere.
                if (this.hasLoaded() || this.loading()) {
                    this.postList.reloadIfStale(forumId);
                } else {
                    this.postList.reload(forumId);
                }
            });
        });

        effect(() => {
            const guildId = this.forum().guildId;
            // Read outside the untracked block on purpose: it's a dependency, not a side effect; see OwnMemberRevisionService, guild.MemberUpdated is what bumps it.
            this.ownMemberRevision.revision();
            untracked(() => this.guildService.getOwnMember(guildId).subscribe(m => this.ownMember.set(m)));
        });
    }

    ngOnDestroy(): void {
        clearInterval(this.tickIntervalId);
        this.postList.releaseActiveForum(this.activeClaim);
    }

    // ── Loading ──────────────────────────────────────────────────────────────
    protected loadMore(): void {
        this.postList.loadMore(this.forum().id);
    }

    /** Infinite scroll: pull the next page once the viewport is within ~2 screens of the end. */
    protected onScroll(event: Event): void {
        const el = event.target as HTMLElement;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < el.clientHeight * 2) this.loadMore();
    }

    // ── Filters ──────────────────────────────────────────────────────────────
    protected toggleTagFilter(tagId: string): void {
        this.postList.toggleTagFilter(this.forum().id, tagId);
    }

    protected clearTagFilter(): void {
        this.postList.clearTagFilter(this.forum().id);
    }

    protected isTagFiltered(tagId: string): boolean {
        return this.selectedTagIds().includes(tagId);
    }

    protected toggleArchived(): void {
        this.postList.toggleArchived(this.forum().id);
    }

    protected setSort(sort: ForumSortOrder): void {
        if (this.sortOrder() === sort) return;
        this.forumState.setSort(this.forum().id, sort);
        this.postList.reload(this.forum().id);
    }

    /** Layout is pure presentation: no refetch, the same posts just draw differently. */
    protected setLayout(layout: ForumLayout): void {
        this.forumState.setLayout(this.forum().id, layout);
    }

    protected emojiUrlFor(tag: ForumTag): string | null {
        return tag.emojiId ? (this.emojiUrls()[tag.emojiId] ?? null) : null;
    }

    // ── Create ───────────────────────────────────────────────────────────────
    protected openCreateDialog(): void {
        this.createName.set('');
        this.createContent.set('');
        this.createTagError.set(false);
        // Pre-select whatever the list is filtered to: if you're reading "bug" posts and hit New Post, a bug report is what you're about to write.
        this.createTagIds.set(this.selectedTagIds().slice(0, this.maxTags));
        this.showCreateDialog.set(true);
    }

    protected createPost(): void {
        const name = this.createName().trim();
        if (!name || this.creating()) return;

        // Mirrors the server: requireTag with no tags is a 400, and losing a typed-out post body to that round trip is the worst possible moment to find out.
        if (this.requireTag() && this.createTagIds().length === 0) {
            this.createTagError.set(true);
            return;
        }
        this.createTagError.set(false);
        this.creating.set(true);

        const content = this.createContent().trim();
        const tagIds = this.createTagIds();
        const forumId = this.forum().id;

        this.guildService
            .createThread(forumId, {
                name,
                content: content || undefined,
                tagIds: tagIds.length ? tagIds : undefined,
            })
            .subscribe({
                next: post => {
                    this.showCreateDialog.set(false);
                    this.creating.set(false);
                    this.navService.openChannel(post);
                    this.postList.reload(forumId);
                },
                error: err => {
                    this.creating.set(false);
                    this.toastService.httpError(this.translate.instant('FORUM.CREATE_ERROR'), err);
                },
            });
    }

    // ── Post actions ─────────────────────────────────────────────────────────
    protected openPost(post: ForumPost): void {
        this.navService.openChannel(post as unknown as ChannelDto);
    }

    protected onPostAction(post: ForumPost, action: PostAction): void {
        const forumId = this.forum().id;
        switch (action) {
            case 'pin':
            case 'unpin': {
                const pinned = action === 'pin';
                this.postList.patchPost(forumId, post.id, {isPinned: pinned});
                this.forumService.setPostPinned(post.id, {pinned}).subscribe({
                    // Pinned posts sort above unpinned ones, so the row has to move, not just re-badge: a reload is what actually reflects the change.
                    next: () => this.postList.reload(forumId),
                    error: err => this.revert(post, err, 'FORUM.PIN_ERROR'),
                });
                break;
            }
            case 'lock':
            case 'unlock': {
                const locked = action === 'lock';
                this.postList.patchPost(forumId, post.id, {isLocked: locked});
                this.forumService.setPostLocked(post.id, {locked}).subscribe({
                    error: err => this.revert(post, err, 'FORUM.LOCK_ERROR'),
                });
                break;
            }
            case 'archive': {
                this.postList.patchPost(forumId, post.id, {isArchived: true});
                this.guildService.archiveThread(post.id).subscribe({
                    next: () => {
                        // Archived posts leave the default list entirely; keeping the card around greyed-out would misrepresent what the filter now matches.
                        if (!this.showArchived()) this.postList.removePost(forumId, post.id);
                    },
                    error: err => this.revert(post, err, 'FORUM.ARCHIVE_ERROR'),
                });
                break;
            }
        }
    }

    /** ForumPostListService restores the row; raising the toast stays here. */
    private revert(original: ForumPost, err: unknown, messageKey: string): void {
        this.postList.revertPost(this.forum().id, original);
        this.toastService.httpError(this.translate.instant(messageKey), err);
    }
}
