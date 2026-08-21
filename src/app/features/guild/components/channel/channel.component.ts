import {
    Component,
    computed,
    DestroyRef,
    effect,
    inject,
    input,
    output,
    signal,
    untracked,
    viewChild,
} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {DatePipe} from '@angular/common';
import {debounceTime, Subject} from 'rxjs';

import {ChannelDto, ChannelType} from '../../../../dtos/response/guild.dto';
import {ForumTag} from '../../../../dtos/response/forum.dto';
import {ForumService} from '../../../../services/forum.service';
import {ForumStateService} from '../../../../services/forum-state.service';
import {GuildEmojiStore} from '../../../../stores/guild-emoji.store';
import {ToastService} from '../../../../services/toast.service';
import {TagChipComponent} from '../../../../components/tag-chip/tag-chip.component';
import {ForumTagPickerComponent} from '../forum-channel/forum-tag-picker.component';
import {Dialog} from 'primeng/dialog';
import {PrimeTemplate} from 'primeng/api';
import {MessageAttachment, MessageDto} from '../../../../dtos/response/message.dto';
import {SelfGuildMemberDto} from '../../../../dtos/response/member.dto';
import {hasPermission, Permissions} from '../../../../enums/permissions.enum';
import {guildAbilities, unionMemberPermissions} from '../../guild-permissions';
import {ModulePermissions} from '../../../../enums/module-permissions.enum';
import {SceneService} from '../../../../services/scene.service';
import {SceneHeaderComponent} from '../../scenes/scene-header/scene-header.component';
import {forumParentOf, sceneChannelIdFor} from './channel-utils';
import {readableContent, UNDECRYPTABLE_SHORT} from '../../../../helpers/message-content.helper';

import {Button} from 'primeng/button';
import {TranslateModule, TranslateService} from '@ngx-translate/core';

import {MessageStore} from '../../../../stores/message.store';
import {ProfileService} from '../../../../services/profile.service';
import {GuildService} from '../../../../services/guild.service';
import {OwnMemberRevisionService} from '../../../../services/own-member-revision.service';

import {NavigationService} from '../../../main-page/navigation.service';
import {HighlightPipe} from '../../../../pipes/highlight.pipe';
import {ThreadPanelComponent} from './thread-panel/thread-panel.component';
import {PinnedMessagesPanelComponent} from '../../../messaging/components/pinned-messages-panel/pinned-messages-panel.component';
import {FollowChannelDialogComponent} from '../follow-channel-dialog/follow-channel-dialog.component';
import {ChannelConversationComponent} from './channel-conversation/channel-conversation.component';
import {ThreadSidePanelComponent} from './thread-side-panel/thread-side-panel.component';
import {GuildFeature, guildHasFeature} from '../../guild-features';
import {RealtimeConnectionService} from '../../../../services/realtime-connection.service';

const THREAD_PANEL_WIDTH_KEY = 'alpine.threadPanel.width';
const THREAD_PANEL_MIN_REM = 20;
const THREAD_PANEL_MAX_REM = 40;
const THREAD_PANEL_DEFAULT_REM = 25;

function clampPanelWidth(rem: number): number {
    return Math.min(THREAD_PANEL_MAX_REM, Math.max(THREAD_PANEL_MIN_REM, rem));
}

function readPanelWidth(): number {
    const raw = Number(localStorage.getItem(THREAD_PANEL_WIDTH_KEY));
    if (!Number.isFinite(raw) || raw <= 0) return THREAD_PANEL_DEFAULT_REM;
    return clampPanelWidth(raw);
}

function decodeContent(encoded: string): string {
    try {
        const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    } catch {
        return '';
    }
}

@Component({
    selector: 'app-channel',
    imports: [
        ChannelConversationComponent,
        ThreadSidePanelComponent,
        Button,
        DatePipe,
        HighlightPipe,
        ThreadPanelComponent,
        PinnedMessagesPanelComponent,
        FollowChannelDialogComponent,
        TranslateModule,
        TagChipComponent,
        ForumTagPickerComponent,
        Dialog,
        PrimeTemplate,
        SceneHeaderComponent,
    ],
    templateUrl: './channel.component.html',
    styleUrl: './channel.component.css',
})
export class ChannelComponent {
    public readonly channel = input.required<ChannelDto>();
    public back = output();
    protected navService = inject(NavigationService);
    protected readonly guildId = computed(() => this.channel().guildId);
    protected readonly guildRoles = computed(() => {
        const ws = this.navService.workspace();
        return ws.type === 'server' ? ws.guild.roles : [];
    });
    protected readonly guildChannels = computed(() => {
        const ws = this.navService.workspace();
        return ws.type === 'server' ? ws.guild.channels : [];
    });
    /** Threads are a module: with it off, the panel and its entry point are absent, not disabled. */
    protected readonly hasThreads = computed(() => {
        const ws = this.navService.workspace();
        return ws.type === 'server' && guildHasFeature(ws.guild, GuildFeature.Threads);
    });
    protected readonly canManageScenes = computed(() => {
        const ws = this.navService.workspace();
        if (ws.type !== 'server') return false;
        return guildAbilities(this.ownMember(), ws.guild, this.profileService.ownProfile()?.userId).canModule(
            ModulePermissions.ManageScenes,
        );
    });

    // ── Scene ────────────────────────────────────────────────────────────────
    // The reads that fetch live in app-channel-conversation; the header only draws what is already loaded.
    protected readonly scenes = inject(SceneService);

    private readonly sceneChannelId = computed(() =>
        sceneChannelIdFor(this.channel().id, this.scenes.scenes(this.guildId())),
    );

    protected readonly scene = computed(() => this.scenes.scene(this.guildId(), this.sceneChannelId()));

    protected readonly sceneSide = computed((): 'ic' | 'ooc' =>
        this.scene()?.channelId === this.channel().id ? 'ic' : 'ooc',
    );

    protected readonly showThreadPanel = signal(false);
    protected readonly showPinnedPanel = signal(false);
    protected readonly showFollowDialog = signal(false);
    protected readonly panelWidth = signal(readPanelWidth());

    // ── Forum post state ─────────────────────────────────────────────────────
    // A forum post is an ordinary Thread channel; this whole view is reused, and these members only light up when the thread's parent turns out to be a forum.
    protected forumState = inject(ForumStateService);
    private forumService = inject(ForumService);
    private emojiStore = inject(GuildEmojiStore);
    private toastService = inject(ToastService);

    protected readonly showTagDialog = signal(false);
    protected readonly tagDraft = signal<string[]>([]);
    protected readonly savingTags = signal(false);
    /** Locally applied flags, so a lock or tag change here doesn't need a channel refetch. */
    private readonly localIsLocked = signal<boolean | null>(null);
    private readonly localTagIds = signal<string[] | null>(null);

    protected readonly parentForum = computed(() => forumParentOf(this.channel(), this.guildChannels()));

    protected readonly isForumPost = computed(() => this.parentForum() !== null);
    protected readonly isLocked = computed(() => this.localIsLocked() ?? this.channel().isLocked ?? false);

    protected readonly forumTags = computed<ForumTag[]>(() => {
        const forum = this.parentForum();
        return forum ? this.forumState.tagsFor(forum.id) : [];
    });

    protected readonly postTagIds = computed(() => this.localTagIds() ?? this.channel().tagIds ?? []);

    protected readonly appliedTags = computed(() => {
        const byId = new Map(this.forumTags().map(t => [t.id, t]));
        return this.postTagIds()
            .map(id => byId.get(id))
            .filter((t): t is ForumTag => !!t);
    });

    protected readonly forumEmojiUrls = computed(() => {
        const map: Record<string, string> = {};
        for (const emoji of this.emojiStore.getEmojis(this.guildId())) map[emoji.id] = emoji.imageUrl;
        return map;
    });

    protected readonly ChannelType = ChannelType;
    protected readonly searchQuery = signal('');
    protected readonly isSearchActive = computed(() => this.searchQuery().trim().length > 0);
    protected readonly isSearching = computed(() => this.searchEntry()?.searching ?? false);
    protected readonly msgResults = computed(() => {
        const q = this.searchQuery().trim().toLowerCase();
        if (!q) return [];
        return (this.searchEntry()?.results ?? []).filter(
            m => !m.undecryptable && decodeContent(m.content).toLowerCase().includes(q),
        );
    });
    protected readonly attResults = computed(() => {
        const q = this.searchQuery().trim().toLowerCase();
        if (!q) return [];
        const out: {message: MessageDto; attachment: MessageAttachment}[] = [];
        for (const m of this.searchEntry()?.results ?? []) {
            for (const a of m.attachments) {
                if (a.fileName.toLowerCase().includes(q)) out.push({message: m, attachment: a});
            }
        }
        return out;
    });
    private messageStore = inject(MessageStore);
    private readonly ownMember = signal<SelfGuildMemberDto | null>(null);

    private readonly threadPermissions = computed(() => {
        const member = this.ownMember();
        if (!member) return 0n;
        return unionMemberPermissions(member);
    });

    protected readonly canManageAnyThread = computed(
        () =>
            hasPermission(this.threadPermissions(), Permissions.Superadmin) ||
            hasPermission(this.threadPermissions(), Permissions.ManageAnyThread),
    );

    /** Some thread payloads omit createdByUserId; when missing, falls back to the moderator bit rather than offering an edit that would 403. */
    protected readonly canEditTags = computed(() => {
        if (!this.isForumPost() || this.forumTags().length === 0) return false;
        if (this.canManageAnyThread()) return true;
        const creatorId = this.channel().createdByUserId;
        return !!creatorId && creatorId === this.profileService.ownProfile()?.userId;
    });

    protected readonly canUseModeratedTags = computed(
        () => this.canManageAnyThread() || hasPermission(this.threadPermissions(), Permissions.ManageChannel),
    );

    protected readonly searchEntry = computed(
        () => this.messageStore.channelSearchEntries()[this.channel().id] ?? null,
    );

    private guildService = inject(GuildService);
    private ownMemberRevision = inject(OwnMemberRevisionService);
    private profileService = inject(ProfileService);
    private realtime = inject(RealtimeConnectionService);
    private translate = inject(TranslateService);
    private searchSubject = new Subject<string>();

    private readonly conversation = viewChild.required<ChannelConversationComponent>('conversation');

    constructor() {
        effect(() => {
            // Re-runs when guild.MemberUpdated says our own roles changed; see ownMemberRevision.
            this.ownMemberRevision.revision();
            this.guildService.getOwnMember(this.guildId()).subscribe(m => this.ownMember.set(m));
        });

        effect(() => {
            // Reset the locally-applied forum flags on channel change, so a previous post's lock/tag state can't bleed into the one now open.
            this.channel().id;
            this.localIsLocked.set(null);
            this.localTagIds.set(null);

            const forum = this.parentForum();
            if (forum) {
                this.forumState.loadFor(forum.id);
                this.emojiStore.ensureLoaded(forum.guildId);
            }
        });

        this.realtime
            .stream('guild.ThreadUpdated')
            .pipe(takeUntilDestroyed(inject(DestroyRef)))
            .subscribe(e => {
                if (e.channelId !== this.channel().id) return;
                // Full current state, not a patch: each present field replaces.
                if (e.isLocked !== undefined) this.localIsLocked.set(e.isLocked);
                if (e.tagIds !== undefined) this.localTagIds.set(e.tagIds);
            });

        // The three side panels share the slot, so raising one lowers the others.
        effect(() => {
            if (!this.navService.threadPanel()) return;
            untracked(() => {
                this.showThreadPanel.set(false);
                this.showPinnedPanel.set(false);
            });
        });

        effect(() => {
            this.channel().id;
            this.searchQuery.set('');
            this.showThreadPanel.set(false);
            this.showPinnedPanel.set(false);
            this.showFollowDialog.set(false);
        });

        this.searchSubject.pipe(debounceTime(300), takeUntilDestroyed()).subscribe(query => {
            if (query.trim()) {
                this.messageStore.searchInChannel(this.channel().id, query);
            } else {
                this.messageStore.clearChannelSearch(this.channel().id);
            }
        });
    }

    // ── Forum post tags ──────────────────────────────────────────────────────

    protected forumEmojiUrlFor(tag: ForumTag): string | null {
        return tag.emojiId ? (this.forumEmojiUrls()[tag.emojiId] ?? null) : null;
    }

    protected openTagDialog(): void {
        this.tagDraft.set([...this.postTagIds()]);
        this.showTagDialog.set(true);
    }

    protected saveTags(): void {
        if (this.savingTags()) return;
        this.savingTags.set(true);

        // Replace semantics: the picker emits the whole desired set, which is what the endpoint wants and what makes a retry safe.
        this.forumService.setPostTags(this.channel().id, {tagIds: this.tagDraft()}).subscribe({
            next: post => {
                this.localTagIds.set(post.tagIds ?? []);
                this.savingTags.set(false);
                this.showTagDialog.set(false);
            },
            error: err => {
                this.savingTags.set(false);
                this.toastService.httpError(this.translate.instant('FORUM.TAG_SAVE_ERROR'), err);
            },
        });
    }
    /** Drag right narrows the panel, so the delta is subtracted. Pointer capture keeps the drag alive over the iframe-free but busy message list. */
    protected startPanelResize(event: PointerEvent): void {
        event.preventDefault();
        const grip = event.target as HTMLElement;
        const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
        const startX = event.clientX;
        const startWidth = this.panelWidth();

        const onMove = (move: PointerEvent): void => {
            this.panelWidth.set(clampPanelWidth(startWidth - (move.clientX - startX) / rootFontSize));
        };
        const onUp = (): void => {
            grip.removeEventListener('pointermove', onMove);
            grip.removeEventListener('pointerup', onUp);
            grip.removeEventListener('pointercancel', onUp);
            try {
                localStorage.setItem(THREAD_PANEL_WIDTH_KEY, String(this.panelWidth()));
            } catch {
                // A full quota must not break the panel.
            }
        };

        grip.setPointerCapture(event.pointerId);
        grip.addEventListener('pointermove', onMove);
        grip.addEventListener('pointerup', onUp);
        grip.addEventListener('pointercancel', onUp);
    }

    /** The three side panels share one slot, so raising either of these lowers the thread. */
    protected toggleThreadList(): void {
        this.navService.closeThread();
        this.showThreadPanel.update(open => !open);
    }

    protected togglePinned(): void {
        this.navService.closeThread();
        this.showPinnedPanel.update(open => !open);
    }

    protected onSearchInput(value: string): void {
        this.searchQuery.set(value);
        this.searchSubject.next(value);
    }

    protected clearSearch(): void {
        this.searchQuery.set('');
        this.messageStore.clearChannelSearch(this.channel().id);
    }

    protected jumpToMessage(messageId: string): void {
        this.clearSearch();
        this.conversation().jumpToMessage(messageId);
    }

    /** Search-result snippet. Whole message, so `undecryptable` is in scope; see the DM twin. */
    protected getSnippet(msg: MessageDto): string {
        return readableContent(msg, UNDECRYPTABLE_SHORT);
    }

    protected getAuthorName(authorId: string): string {
        if (authorId === this.profileService.ownProfile()?.userId) return 'You';
        return this.profileService.getCachedByUserId(authorId)?.userName ?? 'Unknown';
    }

    protected fileIcon(contentType: string): string {
        if (contentType.startsWith('video/')) return 'pi-video';
        if (contentType.startsWith('audio/')) return 'pi-volume-up';
        if (contentType === 'application/pdf') return 'pi-file-pdf';
        if (contentType.includes('zip') || contentType.includes('rar')) return 'pi-folder';
        if (contentType.startsWith('text/')) return 'pi-file-edit';
        return 'pi-file';
    }
}
