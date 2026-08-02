import {
  afterEveryRender,
  AfterViewInit,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  signal,
  ViewChild,
} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {DatePipe} from '@angular/common';
import {HttpErrorResponse} from '@angular/common/http';
import {catchError, debounceTime, EMPTY, firstValueFrom, from, Subject, tap} from 'rxjs';

import {ChannelDto, ChannelType} from '../../../../dtos/response/guild.dto';
import {ForumTag} from '../../../../dtos/response/forum.dto';
import {ForumService} from '../../../../services/forum.service';
import {ForumStateService} from '../../../../services/forum-state.service';
import {GuildEmojiStore} from '../../../../stores/guild-emoji.store';
import {ToastService} from '../../../../services/toast.service';
import {ForumTagChipComponent} from '../forum-channel/forum-tag-chip.component';
import {ForumTagPickerComponent} from '../forum-channel/forum-tag-picker.component';
import {Dialog} from 'primeng/dialog';
import {PrimeTemplate} from 'primeng/api';
import {MessageAttachment, MessageDto} from '../../../../dtos/response/message.dto';
import {SelfGuildMemberDto} from '../../../../dtos/response/member.dto';
import {MessageEncryptionState} from '../../../../enums/message-encryption-state.enum';
import {MessageType} from '../../../../enums/message-type.enum';
import {hasPermission, parsePermissions, Permissions} from '../../../../enums/permissions.enum';
import {isGroupedWithPrevious} from '../../../messaging/components/conversation/message-utils';
import {ChannelEncryptionState, classifyAutoModError, forumParentOf, mayPostCleartext} from './channel-utils';
import {MlsService} from '../../../../services/mls.service';
import {MlsSyncService} from '../../../../services/mls-sync.service';
import {MlsJoinRequestService} from '../../../../services/mls-join-request.service';
import {ChannelAccessBannerComponent} from './channel-access-banner.component';
import {MlsUnreadableBannerComponent} from '../../../../components/mls-unreadable-banner/mls-unreadable-banner.component';
import {readableContent, UNDECRYPTABLE_SHORT} from '../../../../helpers/message-content.helper';
import {toBase64} from '../../../../helpers/base64.helper';

import {Button} from 'primeng/button';
import {TranslateModule, TranslateService} from '@ngx-translate/core';

import {MessagingService} from '../../../../services/messaging.service';
import {MessageStore} from '../../../../stores/message.store';
import {ProfileService} from '../../../../services/profile.service';
import {GuildService} from '../../../../services/guild.service';
import {GuildWebsocketService} from '../../../../services/guild-websocket.service';
import {GuildReadStateService} from '../../../../services/guild-read-state.service';
import {TypingService} from '../../../../services/typing.service';
import {BotCommandService} from '../../../../services/bot-command.service';

import {ComposerComponent} from '../../../messaging/components/conversation/composer/composer.component';
import {NavigationService} from '../../../main-page/navigation.service';
import {MessageComponent} from '../../../messaging/components/conversation/message/message.component';
import {SystemMessageComponent} from '../../../messaging/components/conversation/message/system-message/system-message.component';
import {HighlightPipe} from '../../../../pipes/highlight.pipe';
import {TypingDotsComponent} from '../../../../components/typing-dots/typing-dots.component';
import {ThreadPanelComponent} from './thread-panel/thread-panel.component';
import {PinnedMessagesPanelComponent} from '../../../messaging/components/pinned-messages-panel/pinned-messages-panel.component';
import {FollowChannelDialogComponent} from '../follow-channel-dialog/follow-channel-dialog.component';
import {GuildFeature, guildHasFeature} from '../../guild-features';

const SCROLL_BOTTOM_THRESHOLD = 100;
const LOAD_MORE_THRESHOLD = 400;

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
        ComposerComponent, MessageComponent, SystemMessageComponent, Button,
        DatePipe, HighlightPipe, TypingDotsComponent, ThreadPanelComponent,
        PinnedMessagesPanelComponent, FollowChannelDialogComponent, TranslateModule,
        ChannelAccessBannerComponent, MlsUnreadableBannerComponent,
        ForumTagChipComponent, ForumTagPickerComponent, Dialog, PrimeTemplate,
    ],
    templateUrl: './channel.component.html',
    styleUrl: './channel.component.css',
})
export class ChannelComponent implements AfterViewInit {
    public channel = input.required<ChannelDto>();
    public back = output();
    protected navService = inject(NavigationService);
    protected botCommandService = inject(BotCommandService);
    protected guildId = computed(() => this.channel().guildId);
    protected guildRoles = computed(() => {
        const ws = this.navService.workspace();
        return ws.type === 'server' ? ws.guild.roles : [];
    });
    protected guildChannels = computed(() => {
        const ws = this.navService.workspace();
        return ws.type === 'server' ? ws.guild.channels : [];
    });
    /** Threads are a module: with it off, the panel and its entry point are absent, not disabled. */
    protected hasThreads = computed(() => {
        const ws = this.navService.workspace();
        return ws.type === 'server' && guildHasFeature(ws.guild, GuildFeature.Threads);
    });
    protected replyingTo = signal<MessageDto | null>(null);
    /** Set when the server refuses a send via auto-mod, cleared on the next attempt. */
    protected autoModError = signal<'blocked_word' | 'rate_limited' | null>(null);
    protected showThreadPanel = signal(false);
    protected showPinnedPanel = signal(false);
    /**
     * Three states, not two. 'locked-out' is encrypted-but-this-device-is-not-in-the-group, which
     * used to be treated as plaintext - so the composer offered to send, the server refused, and
     * nothing explained why.
     */
    protected encryptionState = signal<ChannelEncryptionState>('plain');
    protected isLockedOut = computed(() => this.encryptionState() === 'locked-out');
    /** What the last re-link attempt for this channel achieved, as the banner should render it. */
    protected readonly relinkStatus = computed(() => this.joinRequests.statusOf(this.channel().id));
    protected showFollowDialog = signal(false);

    // ── Forum post state ─────────────────────────────────────────────────────
    // A forum post is an ordinary Thread channel, so this whole view is reused for it;
    // these members only light up when the thread's parent turns out to be a forum.
    protected forumState = inject(ForumStateService);
    private forumService = inject(ForumService);
    private emojiStore = inject(GuildEmojiStore);
    private toastService = inject(ToastService);

    protected showTagDialog = signal(false);
    protected tagDraft = signal<string[]>([]);
    protected savingTags = signal(false);
    /** Locally applied flags, so a lock or tag change here doesn't need a channel refetch. */
    private localIsLocked = signal<boolean | null>(null);
    private localTagIds = signal<string[] | null>(null);

    protected parentForum = computed(() => forumParentOf(this.channel(), this.guildChannels()));

    protected isForumPost = computed(() => this.parentForum() !== null);
    protected isLocked = computed(() => this.localIsLocked() ?? this.channel().isLocked ?? false);

    protected forumTags = computed<ForumTag[]>(() => {
        const forum = this.parentForum();
        return forum ? this.forumState.tagsFor(forum.id) : [];
    });

    protected postTagIds = computed(() => this.localTagIds() ?? this.channel().tagIds ?? []);

    protected appliedTags = computed(() => {
        const byId = new Map(this.forumTags().map(t => [t.id, t]));
        return this.postTagIds().map(id => byId.get(id)).filter((t): t is ForumTag => !!t);
    });

    protected forumEmojiUrls = computed(() => {
        const map: Record<string, string> = {};
        for (const emoji of this.emojiStore.getEmojis(this.guildId())) map[emoji.id] = emoji.imageUrl;
        return map;
    });

    protected readonly ChannelType = ChannelType;
    protected readonly MessageType = MessageType;
    protected searchQuery = signal('');
    protected isSearchActive = computed(() => this.searchQuery().trim().length > 0);
    protected isSearching = computed(() => this.searchEntry()?.searching ?? false);
    protected msgResults = computed(() => {
        const q = this.searchQuery().trim().toLowerCase();
        if (!q) return [];
        return (this.searchEntry()?.results ?? []).filter(m =>
            !m.undecryptable && decodeContent(m.content).toLowerCase().includes(q)
        );
    });
    protected attResults = computed(() => {
        const q = this.searchQuery().trim().toLowerCase();
        if (!q) return [];
        const out: Array<{ message: MessageDto; attachment: MessageAttachment }> = [];
        for (const m of (this.searchEntry()?.results ?? [])) {
            for (const a of m.attachments) {
                if (a.fileName.toLowerCase().includes(q)) out.push({message: m, attachment: a});
            }
        }
        return out;
    });
    private messageStore = inject(MessageStore);
    private ownMember = signal<SelfGuildMemberDto | null>(null);
    protected canPinMessages = computed(() => {
        const member = this.ownMember();
        if (!member) return false;
        const permissionString = member.roleMembers.reduce((curr, m) => {
            if (!m.role.permissions) return curr;
            return curr === '' ? m.role.permissions : `${curr},${m.role.permissions}`;
        }, member.permissions ?? '');
        const perms = parsePermissions(permissionString);
        return hasPermission(perms, Permissions.Superadmin) || hasPermission(perms, Permissions.PinMessages);
    });

    private threadPermissions = computed(() => {
        const member = this.ownMember();
        if (!member) return 0n;
        const merged = member.roleMembers.reduce((curr, m) => {
            if (!m.role.permissions) return curr;
            return curr === '' ? m.role.permissions : `${curr},${m.role.permissions}`;
        }, member.permissions ?? '');
        return parsePermissions(merged);
    });

    protected canManageAnyThread = computed(() =>
        hasPermission(this.threadPermissions(), Permissions.Superadmin)
        || hasPermission(this.threadPermissions(), Permissions.ManageAnyThread));

    /**
     * The server allows the post's creator too, but only some thread payloads carry
     * createdByUserId - without it we can't tell, so fall back to the moderator bit
     * rather than offering an edit that will 403.
     */
    protected canEditTags = computed(() => {
        if (!this.isForumPost() || this.forumTags().length === 0) return false;
        if (this.canManageAnyThread()) return true;
        const creatorId = this.channel().createdByUserId;
        return !!creatorId && creatorId === this.profileService.ownProfile()?.userId;
    });

    protected canUseModeratedTags = computed(() =>
        this.canManageAnyThread() || hasPermission(this.threadPermissions(), Permissions.ManageChannel));

    protected messages = computed(() =>
        this.messageStore
            .entities()
            .filter(m => m.channelId === this.channel().id)
            .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    );
    protected messageRows = computed(() => {
        const msgs = this.messages();
        return msgs.map((message, i) => ({
            message,
            isGrouped: isGroupedWithPrevious(message, msgs[i - 1]),
        }));
    });

    // ── Messages ─────────────────────────────────────────────────────────────
    protected hasMore = computed(() =>
        this.messageStore.channelMeta()[this.channel().id]?.hasMore ?? false
    );
    protected loadingMore = computed(() =>
        this.messageStore.channelMeta()[this.channel().id]?.loadingMore ?? false
    );
    protected loadError = computed(() =>
        this.messageStore.channelMeta()[this.channel().id]?.error ?? null
    );
    protected searchEntry = computed(() =>
        this.messageStore.channelSearchEntries()[this.channel().id] ?? null
    );

    // ── Search ───────────────────────────────────────────────────────────────
    private messagingService = inject(MessagingService);
    private mlsService = inject(MlsService);
    private mlsSync = inject(MlsSyncService);
    private joinRequests = inject(MlsJoinRequestService);
    private guildService = inject(GuildService);
    private profileService = inject(ProfileService);
    private guildWs = inject(GuildWebsocketService);
    private translate = inject(TranslateService);
    private readStateService = inject(GuildReadStateService);
    private typingService = inject(TypingService);
    protected typingText = computed(() => {
        const ownId = this.profileService.ownProfile()?.userId;
        const ids = [...(this.typingService.state().get(this.channel().id) ?? [])].filter(id => id !== ownId);
        if (ids.length === 0) return null;
        const names = ids.map(id => this.profileService.getCachedByUserId(id)?.userName ?? 'Someone');
        if (names.length === 1) return `${names[0]} is typing…`;
        if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
        return 'Several people are typing…';
    });
    private searchSubject = new Subject<string>();

    // ── Scroll state ─────────────────────────────────────────────────────────
    @ViewChild('messageScroll') private scrollRef!: ElementRef<HTMLDivElement>;
    @ViewChild('messageList') private messageListRef?: ElementRef<HTMLDivElement>;
    @ViewChild(ComposerComponent) private composerRef?: ComposerComponent;
    private isNearBottom = true;
    private savedScrollHeight = 0;
    private restoreScroll = false;
    private lastScrollChannelId = '';
    private pendingScrollToBottom = false;
    private contentObserver = new ResizeObserver(() => {
        if (this.isNearBottom) this.scrollToBottom();
    });
    private observedListEl?: HTMLDivElement;

    constructor() {
        inject(DestroyRef).onDestroy(() => {
            this.contentObserver.disconnect();
            this.observedListEl?.removeEventListener('load', this.onContentLoad, true);
        });

        effect(() => {
            this.messageStore.loadForChannel(this.channel().id);
        });

        effect(() => {
            // Reconcile this channel's encryption before anything can be typed into it. A device
            // that was offline when encryption was switched on holds no group and would otherwise
            // send plaintext into a room everyone believes is encrypted - the server refuses that,
            // but finding out on send is a worse experience than finding out on open. This also
            // picks up a Welcome minted while we were away.
            const channelId = this.channel().id;
            void this.resolveEncryptionState(channelId);
        });

        effect(() => {
            this.guildService.getOwnMember(this.guildId()).subscribe(m => this.ownMember.set(m));
        });

        effect(() => {
            // Reset the locally-applied forum flags whenever the channel changes, so a
            // previous post's lock or tag state can't bleed into the one now open.
            this.channel().id;
            this.localIsLocked.set(null);
            this.localTagIds.set(null);

            const forum = this.parentForum();
            if (forum) {
                this.forumState.loadFor(forum.id);
                this.emojiStore.ensureLoaded(forum.guildId);
            }
        });

        this.guildWs.threadUpdatedObservable
            .pipe(takeUntilDestroyed(inject(DestroyRef)))
            .subscribe(e => {
                if (e.channelId !== this.channel().id) return;
                // Full current state, not a patch - each present field replaces.
                if (e.isLocked !== undefined) this.localIsLocked.set(e.isLocked);
                if (e.tagIds !== undefined) this.localTagIds.set(e.tagIds);
            });


        effect(() => {
            const channelId = this.channel().id;
            const _ = this.messages();

            if (channelId !== this.lastScrollChannelId) {
                this.lastScrollChannelId = channelId;
                this.isNearBottom = true;
                this.restoreScroll = false;
            }

            if (this.isNearBottom) {
                this.pendingScrollToBottom = true;
            }
        });

        effect(() => {
            const _ = this.channel();
            setTimeout(() => this.composerRef?.focus(), 0);
        });

        effect(() => {
            this.channel().id;
            this.searchQuery.set('');
            this.showThreadPanel.set(false);
            this.showPinnedPanel.set(false);
            this.showFollowDialog.set(false);
            this.autoModError.set(null);
        });

        afterEveryRender(() => {
            if (this.restoreScroll && this.scrollRef) {
                const el = this.scrollRef.nativeElement;
                const heightDiff = el.scrollHeight - this.savedScrollHeight;
                if (heightDiff > 0) el.scrollTop += heightDiff;
                this.restoreScroll = false;
                this.savedScrollHeight = 0;
            } else if (this.pendingScrollToBottom && this.scrollRef) {
                this.scrollToBottom();
                this.pendingScrollToBottom = false;
            }

            const listEl = this.messageListRef?.nativeElement;
            if (listEl !== this.observedListEl) {
                this.contentObserver.disconnect();
                this.observedListEl?.removeEventListener('load', this.onContentLoad, true);
                this.observedListEl = listEl;
                if (listEl) {
                    this.contentObserver.observe(listEl);
                    listEl.addEventListener('load', this.onContentLoad, {capture: true, passive: true});
                }
            }
        });

        effect(() => {
            const msgs = this.messages();
            const channelId = this.channel().id;
            if (msgs.length === 0) return;
            const latest = msgs[msgs.length - 1];
            if (latest.isPending || latest.isFailed) return;
            void this.guildWs.updateLastReadMessageByChannel(latest.id, channelId);
            this.readStateService.markChannelRead(channelId);
        });

        this.searchSubject.pipe(
            debounceTime(300),
            takeUntilDestroyed(),
        ).subscribe(query => {
            if (query.trim()) {
                this.messageStore.searchInChannel(this.channel().id, query);
            } else {
                this.messageStore.clearChannelSearch(this.channel().id);
            }
        });
    }

    // ── Forum post tags ──────────────────────────────────────────────────────

    protected forumEmojiUrlFor(tag: ForumTag): string | null {
        return tag.emojiId ? this.forumEmojiUrls()[tag.emojiId] ?? null : null;
    }

    protected openTagDialog(): void {
        this.tagDraft.set([...this.postTagIds()]);
        this.showTagDialog.set(true);
    }

    protected saveTags(): void {
        if (this.savingTags()) return;
        this.savingTags.set(true);

        // Replace semantics: the picker already emits the whole desired set, which is
        // exactly what this endpoint wants and what makes a retry safe.
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

    // ── Lifecycle ────────────────────────────────────────────────────────────

    ngAfterViewInit(): void {
        this.scrollToBottom();
    }

    public createMessage(event: {
        content: string;
        attachments: string[];
        inReplyTo?: string;
        mentions: string[];
        roleMentions: string[];
        mentionsEveryone: boolean;
        mentionsHere: boolean;
    }): void {
        const {content, attachments, inReplyTo, mentions, roleMentions, mentionsEveryone, mentionsHere} = event;
        const tempId = crypto.randomUUID();
        const now = new Date();
        const channelId = this.channel().id;
        const b64Content = toBase64(content);

        this.replyingTo.set(null);
        this.autoModError.set(null);

        const optimistic: MessageDto = {
            id: tempId,
            content: b64Content,
            channelId,
            conversationId: undefined,
            authorId: this.profileService.ownProfile()?.userId ?? '',
            createdAt: now,
            updatedAt: now,
            isPending: true,
            isFailed: false,
            attachments: [],
            inReplyTo,
            mentions,
            roleMentions,
            mentionsEveryone,
            mentionsHere,
            encryptionState: MessageEncryptionState.Plain,
            mlsEpoch: undefined,
            mlsSequenceNumber: undefined,
            senderDeviceId: undefined,
            type: MessageType.Message,
        };

        this.messageStore.addMessage(optimistic);

        from(this.send(channelId, content, b64Content, {
            attachments, inReplyTo, mentions, roleMentions, mentionsEveryone, mentionsHere,
        })).pipe(
            tap(({confirmed, generation}) => {
                // An encrypted send comes back as ciphertext. We already hold the plaintext and MLS
                // ratchets forward only, so this is the one moment it can be kept - after this our
                // own message is as unreadable to us as anyone else's.
                if (confirmed.encryptionState === MessageEncryptionState.Encrypted) {
                    // Keyed on the generation this device sealed with, not on anything the server
                    // echoed back - the id is the server's, and a cache keyed on the server's
                    // choice alone lets it replay one context's plaintext into another.
                    void this.mlsService.cacheMessage(
                        channelId, generation, confirmed.id, b64Content,
                        this.profileService.ownProfile()?.userId);
                    const shown = {...confirmed, content: b64Content};
                    this.messageStore.confirmMessage(tempId, shown);
                    this.messagingService.messageSentObservable.next(shown);
                    return;
                }
                this.messageStore.confirmMessage(tempId, confirmed);
                this.messagingService.messageSentObservable.next(confirmed);
            }),
            catchError((err: HttpErrorResponse) => {
                this.messageStore.failMessage(tempId);
                // Auto-mod refusals read very differently to a user than a generic send
                // failure, so surface the reason inline by the composer instead of leaving
                // a bare failed-message marker.
                const autoModReason = classifyAutoModError(err);
                if (autoModReason) {
                    this.autoModError.set(autoModReason);
                    this.messageStore.removeMessage(tempId);
                }
                return EMPTY;
            }),
        ).subscribe();
    }

    /**
     * Tries to get this device readable again, from the banner.
     *
     * <p>Re-reading the channel's state joins from any waiting Welcome and replays missed commits,
     * which fixes a device that was behind - and does nothing at all for one that holds no leaf,
     * because `refreshState` cannot add one. That was the whole of this method, so in the state the
     * banner most often names it succeeded trivially and reported nothing.
     * {@link MlsJoinRequestService.relink} tries that first and then asks a member to admit this
     * device, which is the only thing that can fix it.</p>
     *
     * <p>It still deliberately does *not* mint a new signing key: that orphans a device from every
     * group it belongs to, and is never the right response to "I could not read this".</p>
     */
    protected async relinkDevice(): Promise<void> {
        const channelId = this.channel().id;
        await this.joinRequests.relink(channelId, true);

        // Re-derive the composer's view from what the re-link actually left behind, rather than
        // from a second refresh: `relink` has already reconciled state and, where it could, asked
        // to be admitted.
        await this.resolveEncryptionState(channelId);
    }

    /**
     * Works out which of the three states this channel is in for this device.
     *
     * The middle and last were previously conflated: a channel we could not read looked exactly
     * like a plaintext one, so the composer offered to send, the server refused the plaintext, and
     * the user got a failed message with no explanation and no way forward.
     */
    private async resolveEncryptionState(channelId: string): Promise<void> {
        try {
            const state = await this.mlsSync.refreshState(channelId, true);

            if (!state.encrypted) {
                // Never 'plain' above the floor. `state.encrypted` is a server field, and this
                // device holding a group for the channel at some point is local proof that the
                // field is either wrong or describes a change nobody confirmed here. `refreshState`
                // has already recorded the downgrade for the banner; this stops the composer.
                if (await this.mlsService.getEncryptionFloor(channelId) !== null) {
                    this.encryptionState.set('downgraded');
                    return;
                }
                this.encryptionState.set('plain');
                return;
            }

            // refreshState has already tried to join from any waiting Welcome, so holding no group
            // at this point means we genuinely have not been admitted.
            const groupId = await this.mlsService.getActiveGroupId(channelId);
            this.encryptionState.set(groupId ? 'joined' : 'locked-out');
        } catch (err) {
            console.error('Could not resolve channel encryption state', channelId, err);
            // Deliberately not 'plain'. Guessing plaintext on a failed lookup is how ciphertext
            // ends up sent in the clear; leaving the previous state stands still and sends nothing.
        }
    }

    /**
     * Posts to the channel, encrypting when the channel is encrypted.
     *
     * The server refuses a message whose encryption does not match the channel's, which is what a
     * client sees when encryption was toggled while it was composing - or when it has never heard
     * about the toggle at all. That is a stale view rather than a real failure, so a conflict
     * re-reads the channel's state and sends once more.
     */
    private async send(
        channelId: string,
        content: string,
        b64Content: string,
        rest: {
            attachments: string[]; inReplyTo: string | undefined; mentions: string[];
            roleMentions: string[]; mentionsEveryone: boolean; mentionsHere: boolean;
        },
    ): Promise<{ confirmed: MessageDto; generation: number | null }> {
        // The generation travels back out with the confirmation: the plaintext cache is keyed on
        // it, and the only trustworthy source for which generation sealed this message is the one
        // this device used.
        const attempt = async (): Promise<{ confirmed: MessageDto; generation: number | null }> => {
            const generation = await this.mlsService.getKnownGeneration(channelId);
            const floor = await this.mlsService.getEncryptionFloor(channelId);

            if (generation === null) {
                // Refused here rather than by the server: the server's rejection arrives only after
                // the plaintext has left this machine, which is the part that cannot be undone.
                // The conversation composer has always thrown in this situation; this makes the two
                // agree. See `mayPostCleartext` for why the three conditions are not the same.
                if (!mayPostCleartext(generation, this.encryptionState(), floor)) {
                    throw new Error(
                        `Channel ${channelId} is encrypted and this device holds no group for it`);
                }

                const confirmed = await firstValueFrom(this.messagingService.createMessage({
                    content,
                    channelId,
                    conversationId: undefined,
                    ...rest,
                }));
                return {confirmed, generation: null};
            }

            const keyHandle = this.mlsService.keyHandle();
            const groupId = await this.mlsService.getGroupId(channelId, generation);
            if (!keyHandle || !groupId) {
                throw new Error(`No MLS group held for encrypted channel ${channelId}`);
            }

            const {ciphertext, epoch} = await firstValueFrom(
                this.mlsService.sendMessage(groupId, keyHandle, b64Content),
            );

            const confirmed = await firstValueFrom(this.messagingService.createMessage({
                content: ciphertext,
                channelId,
                conversationId: undefined,
                ...rest,
                encryptionState: MessageEncryptionState.Encrypted,
                mlsEpoch: epoch,
                mlsGeneration: generation,
                senderDeviceId: await this.mlsService.getOrCreateDeviceIdentifier(),
            }));
            return {confirmed, generation};
        };

        try {
            return await attempt();
        } catch (err) {
            if (!(err instanceof HttpErrorResponse) || err.status !== 409) throw err;
            // Catches both directions: plaintext into a channel that was just encrypted, and
            // ciphertext into one that was just turned back to plaintext.
            await this.mlsSync.refreshState(channelId, true);
            return attempt();
        }
    }

    // ── Scroll handling ──────────────────────────────────────────────────────

    protected onScroll(): void {
        const el = this.scrollRef.nativeElement;
        const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        this.isNearBottom = fromBottom < SCROLL_BOTTOM_THRESHOLD;

        if (el.scrollTop < LOAD_MORE_THRESHOLD && this.hasMore() && !this.loadingMore()) {
            this.savedScrollHeight = el.scrollHeight;
            this.restoreScroll = true;
            this.messageStore.loadMoreForChannel(this.channel().id);
        }
    }

    protected onSearchInput(value: string): void {
        this.searchQuery.set(value);
        this.searchSubject.next(value);
    }

    // ── Search actions ───────────────────────────────────────────────────────

    protected clearSearch(): void {
        this.searchQuery.set('');
        this.messageStore.clearChannelSearch(this.channel().id);
    }

    protected jumpToMessage(messageId: string): void {
        this.clearSearch();
        setTimeout(() => {
            const el = this.scrollRef?.nativeElement.querySelector(`[data-message-id="${messageId}"]`);
            if (el) {
                el.scrollIntoView({behavior: 'smooth', block: 'center'});
                el.classList.add('msg-highlight');
                setTimeout(() => el.classList.remove('msg-highlight'), 2000);
            }
        }, 50);
    }

    protected retryLoad(): void {
        this.messageStore.clearChannelError(this.channel().id);
        this.messageStore.loadForChannel(this.channel().id);
    }

    protected onReply(msg: MessageDto): void {
        this.replyingTo.set(msg);
        setTimeout(() => this.composerRef?.focus(), 0);
    }

    protected onCancelReply(): void {
        this.replyingTo.set(null);
    }

    /** Search-result snippet. Whole message, so `undecryptable` is in scope - see the DM twin. */
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

    protected onTyping(): void {
        this.guildWs.invokeStartTyping(this.channel().id);
    }

    // ── Message actions ──────────────────────────────────────────────────────

    private readonly onContentLoad = (): void => {
        if (this.isNearBottom) this.scrollToBottom();
    };

    private scrollToBottom(): void {
        if (!this.scrollRef) return;
        const el = this.scrollRef.nativeElement;
        el.scrollTop = el.scrollHeight;
        // Keep flag in sync so the ResizeObserver keeps scrolling for late-loading content.
        this.isNearBottom = true;
    }
}
