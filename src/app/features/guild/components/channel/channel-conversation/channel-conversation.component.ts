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
    signal,
    untracked,
    ViewChild,
} from '@angular/core';
import {HttpErrorResponse} from '@angular/common/http';
import {catchError, EMPTY, firstValueFrom, from, tap} from 'rxjs';

import {ChannelDto} from '../../../../../dtos/response/guild.dto';
import {MessageDto} from '../../../../../dtos/response/message.dto';
import {SelfGuildMemberDto} from '../../../../../dtos/response/member.dto';
import {MessageEncryptionState} from '../../../../../enums/message-encryption-state.enum';
import {MessageType} from '../../../../../enums/message-type.enum';
import {hasPermission, Permissions} from '../../../../../enums/permissions.enum';
import {guildAbilities, unionMemberPermissions} from '../../../guild-permissions';
import {ModulePermissions} from '../../../../../enums/module-permissions.enum';
import {GuildFeature, guildHasFeature} from '../../../guild-features';
import {PersonaService} from '../../../../../services/persona.service';
import {personaIdentity} from '../../../personas/persona-identity';
import {SceneService} from '../../../../../services/scene.service';
import {SceneStatus} from '../../../../../dtos/response/scene.dto';
import {isWaitingOnMe} from '../../../scenes/scene-status';
import {turnClock} from '../../../scenes/scene-clock';
import {SceneConclusionComponent} from '../../../scenes/scene-conclusion/scene-conclusion.component';
import {SceneTurnPrompt} from '../../../../messaging/components/conversation/composer/composer.component';
import {buildMessageRows} from '../../../../messaging/components/conversation/message-utils';
import {
    ChannelEncryptionState,
    classifyAutoModError,
    mayPostCleartext,
    sceneChannelIdFor,
} from '../channel-utils';
import {MlsService} from '../../../../../services/mls.service';
import {MlsSyncService} from '../../../../../services/mls-sync.service';
import {MlsJoinRequestService} from '../../../../../services/mls-join-request.service';
import {ChannelAccessBannerComponent} from '../channel-access-banner.component';
import {MlsUnreadableBannerComponent} from '../../../../../components/mls-unreadable-banner/mls-unreadable-banner.component';
import {toBase64} from '../../../../../helpers/base64.helper';

import {TranslateModule, TranslateService} from '@ngx-translate/core';

import {MessagingService} from '../../../../../services/messaging.service';
import {MessageStore} from '../../../../../stores/message.store';
import {ProfileService} from '../../../../../services/profile.service';
import {GuildService} from '../../../../../services/guild.service';
import {OwnMemberRevisionService} from '../../../../../services/own-member-revision.service';
import {GuildWebsocketService} from '../../../../../services/guild-websocket.service';
import {GuildReadStateService} from '../../../../../services/guild-read-state.service';
import {TypingService} from '../../../../../services/typing.service';
import {BotCommandService} from '../../../../../services/bot-command.service';
import {ToastService} from '../../../../../services/toast.service';

import {ComposerComponent} from '../../../../messaging/components/conversation/composer/composer.component';
import {NavigationService} from '../../../../main-page/navigation.service';
import {MessageComponent} from '../../../../messaging/components/conversation/message/message.component';
import {SystemMessageComponent} from '../../../../messaging/components/conversation/message/system-message/system-message.component';
import {DateDividerComponent} from '../../../../messaging/components/conversation/date-divider/date-divider.component';
import {TypingDotsComponent} from '../../../../../components/typing-dots/typing-dots.component';
import {JumpToPresentComponent} from '../../../../../components/jump-to-present/jump-to-present.component';

const SCROLL_BOTTOM_THRESHOLD = 100;
const LOAD_MORE_THRESHOLD = 400;
const VIEWING_OLDER_THRESHOLD = 500;
const SMOOTH_JUMP_DISTANCE = 600;

/** The scrollback and the composer for one channel. Mounted twice: the main pane, and a thread panel beside it. */
@Component({
    selector: 'app-channel-conversation',
    host: {class: 'contents'},
    imports: [
        ComposerComponent,
        MessageComponent,
        SystemMessageComponent,
        DateDividerComponent,
        TypingDotsComponent,
        ChannelAccessBannerComponent,
        MlsUnreadableBannerComponent,
        JumpToPresentComponent,
        SceneConclusionComponent,
        TranslateModule,
    ],
    templateUrl: './channel-conversation.component.html',
    styleUrl: './channel-conversation.component.css',
})
export class ChannelConversationComponent implements AfterViewInit {
    public readonly channel = input.required<ChannelDto>();
    /** False while the host shows something else in the same slot, currently search results. */
    public readonly showMessages = input<boolean>(true);
    public readonly variant = input<'main' | 'panel'>('main');
    /** A locked forum post keeps its scrollback and loses its composer; the host owns the flag. */
    public readonly locked = input<boolean>(false);

    protected navService = inject(NavigationService);
    protected botCommandService = inject(BotCommandService);
    protected readonly scenes = inject(SceneService);
    protected readonly passing = signal(false);

    protected readonly guildId = computed(() => this.channel().guildId);
    protected readonly guildRoles = computed(() => {
        const ws = this.navService.workspace();
        return ws.type === 'server' ? ws.guild.roles : [];
    });
    protected readonly guildChannels = computed(() => {
        const ws = this.navService.workspace();
        return ws.type === 'server' ? ws.guild.channels : [];
    });
    protected readonly canUsePersonas = computed(() => {
        const ws = this.navService.workspace();
        if (ws.type !== 'server') return false;
        const own = this.ownMember();
        const ownUserId = this.profileService.ownProfile()?.userId;
        return guildAbilities(own, ws.guild, ownUserId).canModule(ModulePermissions.UsePersonas);
    });
    protected readonly canRollDice = computed(() => {
        const ws = this.navService.workspace();
        if (ws.type !== 'server') return false;
        return guildAbilities(this.ownMember(), ws.guild, this.profileService.ownProfile()?.userId).canModule(
            ModulePermissions.RollDice,
        );
    });

    // ── Scene ────────────────────────────────────────────────────────────────
    protected readonly hasScenes = computed(() => {
        const ws = this.navService.workspace();
        return ws.type === 'server' && guildHasFeature(ws.guild, GuildFeature.Scenes);
    });

    private readonly sceneChannelId = computed(() =>
        sceneChannelIdFor(this.channel().id, this.scenes.scenes(this.guildId())),
    );

    protected readonly scene = computed(() => this.scenes.scene(this.guildId(), this.sceneChannelId()));

    protected readonly sceneSide = computed((): 'ic' | 'ooc' =>
        this.scene()?.channelId === this.channel().id ? 'ic' : 'ooc',
    );

    /** Only the in-character half closes with the ending mark; the companion thread stays open. */
    protected readonly concludedScene = computed(() => {
        const scene = this.scene();
        return scene?.status === SceneStatus.Concluded && this.sceneSide() === 'ic' ? scene : null;
    });

    protected readonly sceneTurn = computed((): SceneTurnPrompt | null => {
        const scene = this.scene();
        if (!scene || this.sceneSide() !== 'ic') return null;
        if (!isWaitingOnMe(scene, this.scenes.speakableIds(this.guildId()))) return null;

        const participant = scene.participants.find(p => p.personaId === scene.currentTurnPersonaId);
        const identity = this.personaService.identity(
            this.guildId(),
            scene.currentTurnPersonaId,
            participant,
        );
        return {
            characterName: identity?.name ?? '',
            deadlineAt: scene.turnDeadlineAt ?? null,
            overdue: turnClock(scene, this.scenes.now()).overdue,
            pass: () => this.passTurn(),
            passing: this.passing(),
        };
    });

    /** Ciphertext hides the proxy tag from the server, so the composer has to resolve it here. */
    protected readonly resolvePersonaLocally = computed(() => this.encryptionState() === 'joined');
    protected readonly replyingTo = signal<MessageDto | null>(null);
    /** Set when the server refuses a send via auto-mod, cleared on the next attempt. */
    protected readonly autoModError = signal<'blocked_word' | 'rate_limited' | null>(null);
    /** Three states, not two: 'locked-out' means encrypted but this device is not in the group. */
    protected readonly encryptionState = signal<ChannelEncryptionState>('plain');
    protected readonly isLockedOut = computed(() => this.encryptionState() === 'locked-out');
    /** What the last re-link attempt for this channel achieved, as the banner should render it. */
    protected readonly relinkStatus = computed(() => this.joinRequests.statusOf(this.channel().id));

    protected readonly MessageType = MessageType;

    private messageStore = inject(MessageStore);
    private readonly ownMember = signal<SelfGuildMemberDto | null>(null);

    protected readonly canPinMessages = computed(() => {
        const member = this.ownMember();
        if (!member) return false;
        const perms = unionMemberPermissions(member);
        return hasPermission(perms, Permissions.Superadmin) || hasPermission(perms, Permissions.PinMessages);
    });

    /** Lets a moderator dismiss a link preview on someone else's message. */
    protected readonly canDeleteAnyMessage = computed(
        () =>
            hasPermission(this.threadPermissions(), Permissions.Superadmin) ||
            hasPermission(this.threadPermissions(), Permissions.DeleteAnyMessage),
    );

    private readonly threadPermissions = computed(() => {
        const member = this.ownMember();
        if (!member) return 0n;
        return unionMemberPermissions(member);
    });

    protected readonly messages = computed(() =>
        this.messageStore
            .entities()
            .filter(m => m.channelId === this.channel().id)
            .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
    );
    protected readonly messageRows = computed(() => buildMessageRows(this.messages()));

    protected readonly hasMore = computed(
        () => this.messageStore.channelMeta()[this.channel().id]?.hasMore ?? false,
    );
    protected readonly loadingMore = computed(
        () => this.messageStore.channelMeta()[this.channel().id]?.loadingMore ?? false,
    );
    protected readonly loadError = computed(
        () => this.messageStore.channelMeta()[this.channel().id]?.error ?? null,
    );

    private messagingService = inject(MessagingService);
    private mlsService = inject(MlsService);
    private mlsSync = inject(MlsSyncService);
    private joinRequests = inject(MlsJoinRequestService);
    private guildService = inject(GuildService);
    private ownMemberRevision = inject(OwnMemberRevisionService);
    private personaService = inject(PersonaService);
    private profileService = inject(ProfileService);
    private guildWs = inject(GuildWebsocketService);
    private readStateService = inject(GuildReadStateService);
    private typingService = inject(TypingService);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);

    protected readonly typingText = computed(() => {
        const ownId = this.profileService.ownProfile()?.userId;
        const ids = [...(this.typingService.state().get(this.channel().id) ?? [])].filter(id => id !== ownId);
        if (ids.length === 0) return null;
        const names = ids.map(id => this.profileService.getCachedByUserId(id)?.userName ?? 'Someone');
        if (names.length === 1) return `${names[0]} is typing…`;
        if (names.length === 2) return `${names[0]} and ${names[1]} are typing…`;
        return 'Several people are typing…';
    });

    // ── Scroll state ─────────────────────────────────────────────────────────
    @ViewChild('messageScroll') private scrollRef!: ElementRef<HTMLDivElement>;
    @ViewChild('messageList') private messageListRef?: ElementRef<HTMLDivElement>;
    @ViewChild(ComposerComponent) private composerRef?: ComposerComponent;
    private isNearBottom = true;
    /** Drives the jump-to-present pill. Further from the bottom than isNearBottom, so a small nudge does not raise it. */
    protected readonly isViewingOlder = signal(false);
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
            // Reconciles encryption before anything can be typed; also picks up a Welcome minted while we were away.
            const channelId = this.channel().id;
            void this.resolveEncryptionState(channelId);
        });

        effect(() => {
            // Re-runs when guild.MemberUpdated says our own roles changed; see ownMemberRevision.
            this.ownMemberRevision.revision();
            this.guildService.getOwnMember(this.guildId()).subscribe(m => this.ownMember.set(m));
        });

        effect(() => {
            const guildId = this.guildId();
            if (this.hasScenes()) untracked(() => this.scenes.ensureGuild(guildId));
        });

        effect(() => {
            // The board carries rows, not scenes; the cast and the rotation need this second read.
            const channelId = this.sceneChannelId();
            if (channelId) untracked(() => this.scenes.refreshScene(this.guildId(), channelId));
        });

        effect(() => {
            const channelId = this.channel().id;
            const _ = this.messages();

            if (channelId !== this.lastScrollChannelId) {
                this.lastScrollChannelId = channelId;
                this.isNearBottom = true;
                this.isViewingOlder.set(false);
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
            const _channelId = this.channel().id;
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

            // New messages arriving while scrolled up grow the list without firing a scroll event.
            if (this.scrollRef) this.measureScroll();

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
    }

    ngAfterViewInit(): void {
        this.scrollToBottom();
    }

    public createMessage(event: {
        content: string;
        attachments: string[];
        inReplyTo?: string;
        mentions: string[];
        roleMentions: string[];
        personaMentions: string[];
        mentionsEveryone: boolean;
        mentionsHere: boolean;
        personaId?: string;
    }): void {
        const {
            content,
            attachments,
            inReplyTo,
            mentions,
            roleMentions,
            personaMentions,
            mentionsEveryone,
            mentionsHere,
            personaId,
        } = event;
        const tempId = crypto.randomUUID();
        const now = new Date();
        const channelId = this.channel().id;
        const b64Content = toBase64(content);

        this.replyingTo.set(null);
        this.autoModError.set(null);

        const speaking = this.personaService.entry(this.guildId(), personaId);
        const optimisticIdentity = speaking ? personaIdentity(speaking) : null;

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
            personaId,
            // The server sends its own copy back; this only keeps the character on screen in the
            // moment between Enter and the confirmation.
            authorDisplayName: optimisticIdentity?.name ?? null,
            authorAvatarUrl: optimisticIdentity?.avatarUrl ?? null,
        };

        this.messageStore.addMessage(optimistic);
        // The turn advances server-side when the character posts, and no event says so; this keeps
        // the rail honest in the meantime. See SceneService.notePost.
        this.scenes.notePost(this.guildId(), channelId, personaId ?? null);

        from(
            this.send(channelId, content, b64Content, {
                attachments,
                inReplyTo,
                mentions,
                roleMentions,
                personaMentions,
                mentionsEveryone,
                mentionsHere,
                personaId,
            }),
        )
            .pipe(
                tap(({confirmed, generation}) => {
                    // Encrypted send returns ciphertext; MLS ratchets forward only, so this is the one moment the plaintext can still be cached.
                    if (confirmed.encryptionState === MessageEncryptionState.Encrypted) {
                        // Keyed on the generation this device sealed with, not the server's id: keying on the server's choice alone would let it replay one context's plaintext into another.
                        void this.mlsService.cacheMessage(
                            channelId,
                            generation,
                            confirmed.id,
                            b64Content,
                            this.profileService.ownProfile()?.userId,
                        );
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
                    const autoModReason = classifyAutoModError(err);
                    if (autoModReason) {
                        this.autoModError.set(autoModReason);
                        this.messageStore.removeMessage(tempId);
                    }
                    return EMPTY;
                }),
            )
            .subscribe();
    }

    /** Passing without posting. The scene moves on and the timeline says who passed. */
    protected passTurn(): void {
        const scene = this.scene();
        if (!scene || this.passing()) return;
        this.passing.set(true);
        this.scenes.advanceTurn(this.guildId(), scene.channelId).subscribe({
            next: () => this.passing.set(false),
            error: err => {
                this.passing.set(false);
                this.toastService.httpError(this.translate.instant('SCENE.TOAST.FAILED'), err);
            },
        });
    }

    /** Tries to get this device readable again, from the banner; {@link MlsJoinRequestService.relink} does the retry and, if needed, asks a member to admit this device. Deliberately never mints a new signing key: that would orphan the device from every group it belongs to. */
    protected async relinkDevice(): Promise<void> {
        const channelId = this.channel().id;
        await this.joinRequests.relink(channelId, true);

        // Re-derive the composer's view from what the re-link actually left behind, rather than
        // from a second refresh: `relink` has already reconciled state and, where it could, asked
        // to be admitted.
        await this.resolveEncryptionState(channelId);
    }

    /** Works out which of the three encryption states this channel is in for this device. */
    private async resolveEncryptionState(channelId: string): Promise<void> {
        try {
            const state = await this.mlsSync.refreshState(channelId, true);

            if (!state.encrypted) {
                // Never 'plain' above the floor: this device having held a group for the channel is local proof that state.encrypted being false is stale or wrong, not a real downgrade.
                if ((await this.mlsService.getEncryptionFloor(channelId)) !== null) {
                    this.encryptionState.set('downgraded');
                    return;
                }
                this.encryptionState.set('plain');
                return;
            }

            // refreshState already tried to join from any waiting Welcome, so holding no group here means we genuinely have not been admitted.
            const groupId = await this.mlsService.getActiveGroupId(channelId);
            this.encryptionState.set(groupId ? 'joined' : 'locked-out');
        } catch (err) {
            console.error('Could not resolve channel encryption state', channelId, err);
            // Deliberately not 'plain': guessing plaintext on a failed lookup is how ciphertext ends up sent in the clear, so this leaves the previous state instead.
        }
    }

    /** Posts to the channel, encrypting when the channel is encrypted; a 409 means the client's encryption state is stale (channel encryption toggled), so it re-reads and sends once more. */
    private async send(
        channelId: string,
        content: string,
        b64Content: string,
        rest: {
            attachments: string[];
            inReplyTo: string | undefined;
            mentions: string[];
            roleMentions: string[];
            personaMentions: string[];
            mentionsEveryone: boolean;
            mentionsHere: boolean;
            personaId: string | undefined;
        },
    ): Promise<{confirmed: MessageDto; generation: number | null}> {
        // The generation travels back out with the confirmation: the plaintext cache is keyed on it, since this device is the only trustworthy source for which generation sealed the message.
        const attempt = async (): Promise<{confirmed: MessageDto; generation: number | null}> => {
            const generation = await this.mlsService.getKnownGeneration(channelId);
            const floor = await this.mlsService.getEncryptionFloor(channelId);

            if (generation === null) {
                // Refused here rather than by the server: the server's rejection only arrives after the plaintext has already left this machine, which can't be undone. See `mayPostCleartext` for why the three conditions differ.
                if (!mayPostCleartext(generation, this.encryptionState(), floor)) {
                    throw new Error(
                        `Channel ${channelId} is encrypted and this device holds no group for it`,
                    );
                }

                const confirmed = await firstValueFrom(
                    this.messagingService.createMessage({
                        content,
                        channelId,
                        conversationId: undefined,
                        ...rest,
                    }),
                );
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

            const confirmed = await firstValueFrom(
                this.messagingService.createMessage({
                    content: ciphertext,
                    channelId,
                    conversationId: undefined,
                    ...rest,
                    encryptionState: MessageEncryptionState.Encrypted,
                    mlsEpoch: epoch,
                    mlsGeneration: generation,
                    senderDeviceId: await this.mlsService.getOrCreateDeviceIdentifier(),
                }),
            );
            return {confirmed, generation};
        };

        try {
            return await attempt();
        } catch (err) {
            if (!(err instanceof HttpErrorResponse) || err.status !== 409) throw err;
            // Catches both directions: plaintext into a channel that was just encrypted, and ciphertext into one that was just turned back to plaintext.
            await this.mlsSync.refreshState(channelId, true);
            return attempt();
        }
    }

    // ── Scroll handling ──────────────────────────────────────────────────────

    protected onScroll(): void {
        const el = this.scrollRef.nativeElement;
        this.measureScroll();

        if (el.scrollTop < LOAD_MORE_THRESHOLD && this.hasMore() && !this.loadingMore()) {
            this.savedScrollHeight = el.scrollHeight;
            this.restoreScroll = true;
            this.messageStore.loadMoreForChannel(this.channel().id);
        }
    }

    public jumpToMessage(messageId: string): void {
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

    protected onTyping(): void {
        this.guildWs.invokeStartTyping(this.channel().id);
    }

    private readonly onContentLoad = (): void => {
        if (this.isNearBottom) this.scrollToBottom();
    };

    private measureScroll(): void {
        const el = this.scrollRef.nativeElement;
        const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        this.isNearBottom = fromBottom < SCROLL_BOTTOM_THRESHOLD;
        this.isViewingOlder.set(fromBottom > VIEWING_OLDER_THRESHOLD);
    }

    /** Jump-to-present. Anything further up hard-cuts first, so the animated part is the same length from any depth. */
    protected jumpToPresent(): void {
        if (!this.scrollRef) return;
        const el = this.scrollRef.nativeElement;
        const target = el.scrollHeight - el.clientHeight;
        if (target - el.scrollTop > SMOOTH_JUMP_DISTANCE) el.scrollTop = target - SMOOTH_JUMP_DISTANCE;
        el.scrollTo({top: target, behavior: 'smooth'});
    }

    private scrollToBottom(): void {
        if (!this.scrollRef) return;
        const el = this.scrollRef.nativeElement;
        el.scrollTop = el.scrollHeight;
        // Keep flag in sync so the ResizeObserver keeps scrolling for late-loading content.
        this.isNearBottom = true;
        this.isViewingOlder.set(false);
    }
}
