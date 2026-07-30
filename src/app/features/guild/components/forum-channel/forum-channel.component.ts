import {
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    effect,
    inject,
    input,
    OnDestroy,
    output,
    signal,
    untracked,
} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
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
    ForumPostSort,
    ForumSortOrder,
    ForumTag,
} from '../../../../dtos/response/forum.dto';
import {GuildService} from '../../../../services/guild.service';
import {ForumService} from '../../../../services/forum.service';
import {ForumStateService} from '../../../../services/forum-state.service';
import {GuildEmojiStore} from '../../../../stores/guild-emoji.store';
import {GuildWebsocketService} from '../../../../services/guild-websocket.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {ToastService} from '../../../../services/toast.service';
import {ProfileService} from '../../../../services/profile.service';
import {SelfGuildMemberDto} from '../../../../dtos/response/member.dto';
import {effectiveGuildPermissions} from '../../guild-permissions';
import {hasPermission, Permissions} from '../../../../enums/permissions.enum';
import {ForumTagChipComponent} from './forum-tag-chip.component';
import {ForumTagPickerComponent} from './forum-tag-picker.component';
import {ForumPostCardComponent, PostAction} from './forum-post-card.component';

const PAGE_SIZE = 25;

@Component({
    selector: 'app-forum-channel',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [
        Button, InputText, Textarea, Dialog, Menu, Tooltip, FormsModule, PrimeTemplate, TranslateModule,
        ForumTagChipComponent, ForumTagPickerComponent, ForumPostCardComponent,
    ],
    templateUrl: './forum-channel.component.html',
})
export class ForumChannelComponent implements OnDestroy {
    channel = input.required<ChannelDto>();
    back = output();

    protected readonly ForumLayout = ForumLayout;
    protected readonly maxTags = FORUM_LIMITS.tagsPerPost;

    // ── Post list ────────────────────────────────────────────────────────────
    protected posts = signal<ForumPost[]>([]);
    protected loading = signal(true);
    protected loadingMore = signal(false);
    protected nextCursor = signal<string | null>(null);

    // ── Filters. Changing any of these invalidates the cursor, so every setter
    // routes through applyFilterChange() rather than mutating and hoping. ─────
    protected selectedTagIds = signal<string[]>([]);
    protected showArchived = signal(false);

    // ── Create dialog ────────────────────────────────────────────────────────
    protected showCreateDialog = signal(false);
    protected createName = signal('');
    protected createContent = signal('');
    protected createTagIds = signal<string[]>([]);
    protected creating = signal(false);
    protected createTagError = signal(false);

    protected navService = inject(NavigationService);
    protected forumState = inject(ForumStateService);
    private guildService = inject(GuildService);
    private forumService = inject(ForumService);
    private emojiStore = inject(GuildEmojiStore);
    private guildWsService = inject(GuildWebsocketService);
    private profileService = inject(ProfileService);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);
    private destroyRef = inject(DestroyRef);

    private ownMember = signal<SelfGuildMemberDto | null>(null);

    /** Ticked so the cards' relative timestamps age without each pipe reading the clock. */
    protected nowTick = signal(0);
    private tickIntervalId = setInterval(() => this.nowTick.update(n => n + 1), 60_000);

    protected isMedia = computed(() => this.channel().type === ChannelType.Media);

    protected tags = computed(() => this.forumState.tagsFor(this.channel().id));
    protected config = computed(() => this.forumState.configFor(this.channel().id));
    protected layout = computed(() => this.forumState.layoutFor(this.channel().id));
    protected sortOrder = computed(() => this.forumState.sortFor(this.channel().id));
    protected requireTag = computed(() => this.config()?.requireTag ?? false);

    /** Guild emoji id → presigned url, for tags whose emoji is a custom guild one. */
    protected emojiUrls = computed(() => {
        const map: Record<string, string> = {};
        for (const emoji of this.emojiStore.getEmojis(this.channel().guildId)) {
            map[emoji.id] = emoji.imageUrl;
        }
        return map;
    });

    private permissions = computed(() => effectiveGuildPermissions(this.ownMember()));

    private isOwner = computed(() => {
        const ws = this.navService.workspace();
        const ownUserId = this.profileService.ownProfile()?.userId;
        return ws.type === 'server' && ws.guild.id === this.channel().guildId
            && !!ownUserId && ownUserId === ws.guild.ownerId;
    });

    /** Owner first: SelfGuildMemberDto.permissions doesn't reliably carry Superadmin for them. */
    private can = (permission: bigint) => this.isOwner()
        || hasPermission(this.permissions(), Permissions.Superadmin)
        || hasPermission(this.permissions(), permission);

    protected canCreatePost = computed(() => this.can(Permissions.CreateThreads));
    protected canModerate = computed(() => this.can(Permissions.ManageAnyThread));
    /** Gate for applying moderated tags - the server accepts either bit. */
    protected canUseModeratedTags = computed(() =>
        this.can(Permissions.ManageAnyThread) || this.can(Permissions.ManageChannel));

    protected sortMenuItems = computed<MenuItem[]>(() => [
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
            const forumId = this.channel().id;
            const guildId = this.channel().guildId;
            untracked(() => {
                this.forumState.loadFor(forumId);
                this.emojiStore.ensureLoaded(guildId);
                // Filters belong to the forum you were looking at, not the one you just
                // opened - carrying them across would silently hide posts in the new forum.
                this.selectedTagIds.set([]);
                this.showArchived.set(false);
                this.reload();
            });
        });

        effect(() => {
            const guildId = this.channel().guildId;
            untracked(() => this.guildService.getOwnMember(guildId).subscribe(m => this.ownMember.set(m)));
        });

        this.guildWsService.threadCreatedObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(e => {
                if (e.parentChannelId !== this.channel().id) return;
                // A new post can land anywhere in the current filter/sort, and the cursor
                // can't express "insert here" - a reload from page one is the only way to
                // place it correctly without desynchronizing pagination.
                this.reload();
            });

        this.guildWsService.threadUpdatedObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(e => {
                if (e.parentChannelId !== this.channel().id) return;
                this.applyThreadUpdate(e.channelId, e);
            });

        // A deleted tag isn't accompanied by per-post updates, so strip it locally.
        this.guildWsService.forumTagDeletedObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(e => {
                if (e.channelId !== this.channel().id) return;
                this.posts.update(list => list.map(p => ({...p, tagIds: p.tagIds.filter(id => id !== e.tagId)})));
                if (this.selectedTagIds().includes(e.tagId)) {
                    this.selectedTagIds.update(ids => ids.filter(id => id !== e.tagId));
                    this.reload();
                }
            });
    }

    ngOnDestroy(): void {
        clearInterval(this.tickIntervalId);
    }

    // ── Loading ──────────────────────────────────────────────────────────────
    protected reload(): void {
        this.loading.set(true);
        this.nextCursor.set(null);
        this.fetch(undefined, page => {
            this.posts.set(page);
            this.loading.set(false);
        });
    }

    protected loadMore(): void {
        const cursor = this.nextCursor();
        if (!cursor || this.loadingMore() || this.loading()) return;
        this.loadingMore.set(true);
        this.fetch(cursor, page => {
            // Keyset pagination never duplicates, but a concurrent reload can land first -
            // de-duping by id keeps a raced append from doubling a row.
            this.posts.update(list => {
                const seen = new Set(list.map(p => p.id));
                return [...list, ...page.filter(p => !seen.has(p.id))];
            });
            this.loadingMore.set(false);
        });
    }

    /** Infinite scroll: pull the next page once the viewport is within ~2 screens of the end. */
    protected onScroll(event: Event): void {
        const el = event.target as HTMLElement;
        if (el.scrollHeight - el.scrollTop - el.clientHeight < el.clientHeight * 2) this.loadMore();
    }

    private fetch(cursor: string | undefined, apply: (posts: ForumPost[]) => void): void {
        const forumId = this.channel().id;
        const tagIds = this.selectedTagIds();

        this.forumService.getPosts(forumId, {
            tagIds: tagIds.length ? tagIds : undefined,
            // Multi-select reads as "narrow this down", which is `all`; with one tag the
            // two modes are equivalent, so this is safe to send unconditionally.
            match: tagIds.length > 1 ? 'all' : undefined,
            sort: this.sortOrder() === ForumSortOrder.CreationDate ? 'created' : 'activity',
            archived: this.showArchived() ? 'all' : 'false',
            limit: PAGE_SIZE,
            cursor,
        }).subscribe({
            next: page => {
                // A response for a forum the user has already navigated away from must not
                // overwrite the list they're now looking at.
                if (this.channel().id !== forumId) return;
                this.nextCursor.set(page.nextCursor);
                apply(page.posts ?? []);
            },
            error: err => {
                this.loading.set(false);
                this.loadingMore.set(false);
                this.toastService.httpError(this.translate.instant('FORUM.LOAD_ERROR'), err);
            },
        });
    }

    // ── Filters ──────────────────────────────────────────────────────────────
    protected toggleTagFilter(tagId: string): void {
        this.selectedTagIds.update(ids =>
            ids.includes(tagId) ? ids.filter(id => id !== tagId) : [...ids, tagId]);
        this.reload();
    }

    protected clearTagFilter(): void {
        if (this.selectedTagIds().length === 0) return;
        this.selectedTagIds.set([]);
        this.reload();
    }

    protected isTagFiltered(tagId: string): boolean {
        return this.selectedTagIds().includes(tagId);
    }

    protected toggleArchived(): void {
        this.showArchived.update(v => !v);
        this.reload();
    }

    protected setSort(sort: ForumSortOrder): void {
        if (this.sortOrder() === sort) return;
        this.forumState.setSort(this.channel().id, sort);
        this.reload();
    }

    /** Layout is pure presentation - no refetch, the same posts just draw differently. */
    protected setLayout(layout: ForumLayout): void {
        this.forumState.setLayout(this.channel().id, layout);
    }

    protected emojiUrlFor(tag: ForumTag): string | null {
        return tag.emojiId ? this.emojiUrls()[tag.emojiId] ?? null : null;
    }

    // ── Create ───────────────────────────────────────────────────────────────
    protected openCreateDialog(): void {
        this.createName.set('');
        this.createContent.set('');
        this.createTagError.set(false);
        // Pre-select whatever the list is filtered to: if you're reading "bug" posts and
        // hit New Post, a bug report is what you're about to write.
        this.createTagIds.set(this.selectedTagIds().slice(0, this.maxTags));
        this.showCreateDialog.set(true);
    }

    protected createPost(): void {
        const name = this.createName().trim();
        if (!name || this.creating()) return;

        // Mirrors the server: requireTag with no tags is a 400, and losing a typed-out
        // post body to that round trip is the worst possible moment to find out.
        if (this.requireTag() && this.createTagIds().length === 0) {
            this.createTagError.set(true);
            return;
        }
        this.createTagError.set(false);
        this.creating.set(true);

        const content = this.createContent().trim();
        const tagIds = this.createTagIds();

        this.guildService.createThread(this.channel().id, {
            name,
            content: content || undefined,
            tagIds: tagIds.length ? tagIds : undefined,
        }).subscribe({
            next: post => {
                this.showCreateDialog.set(false);
                this.creating.set(false);
                this.navService.openChannel(post);
                this.reload();
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
        switch (action) {
            case 'pin':
            case 'unpin': {
                const pinned = action === 'pin';
                this.patchPost(post.id, {isPinned: pinned});
                this.forumService.setPostPinned(post.id, {pinned}).subscribe({
                    // Pinned posts sort above unpinned ones, so the row has to move, not
                    // just re-badge - a reload is what actually reflects the change.
                    next: () => this.reload(),
                    error: err => this.revert(post, err, 'FORUM.PIN_ERROR'),
                });
                break;
            }
            case 'lock':
            case 'unlock': {
                const locked = action === 'lock';
                this.patchPost(post.id, {isLocked: locked});
                this.forumService.setPostLocked(post.id, {locked}).subscribe({
                    error: err => this.revert(post, err, 'FORUM.LOCK_ERROR'),
                });
                break;
            }
            case 'archive': {
                this.patchPost(post.id, {isArchived: true});
                this.guildService.archiveThread(post.id).subscribe({
                    next: () => {
                        // Archived posts leave the default list entirely; keeping the card
                        // around greyed-out would misrepresent what the filter now matches.
                        if (!this.showArchived()) this.posts.update(l => l.filter(p => p.id !== post.id));
                    },
                    error: err => this.revert(post, err, 'FORUM.ARCHIVE_ERROR'),
                });
                break;
            }
        }
    }

    /** Optimistic local edit; every caller pairs it with a revert on failure. */
    private patchPost(postId: string, patch: Partial<ForumPost>): void {
        this.posts.update(list => list.map(p => p.id === postId ? {...p, ...patch} : p));
    }

    private revert(original: ForumPost, err: unknown, messageKey: string): void {
        this.posts.update(list => list.map(p => p.id === original.id ? original : p));
        this.toastService.httpError(this.translate.instant(messageKey), err);
    }

    /**
     * ThreadUpdated carries the full current state of the flags it sends, so each present
     * field replaces rather than merges. An update for a post not on screen is ignored -
     * it'll arrive correct on the next fetch.
     */
    private applyThreadUpdate(
        postId: string,
        e: {name?: string; tagIds?: string[]; isPinned?: boolean; isLocked?: boolean; isArchived?: boolean},
    ): void {
        const patch: Partial<ForumPost> = {};
        if (e.name !== undefined) patch.name = e.name;
        if (e.tagIds !== undefined) patch.tagIds = e.tagIds;
        if (e.isPinned !== undefined) patch.isPinned = e.isPinned;
        if (e.isLocked !== undefined) patch.isLocked = e.isLocked;
        if (e.isArchived !== undefined) patch.isArchived = e.isArchived;

        this.posts.update(list => {
            if (!list.some(p => p.id === postId)) return list;
            const next = list.map(p => p.id === postId ? {...p, ...patch} : p);
            return e.isArchived && !this.showArchived() ? next.filter(p => p.id !== postId) : next;
        });
    }
}
