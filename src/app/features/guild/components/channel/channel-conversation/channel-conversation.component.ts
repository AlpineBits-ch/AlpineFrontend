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
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';

import {ChannelDto, ChannelType} from '../../../../../dtos/response/guild.dto';
import {MessageDto} from '../../../../../dtos/response/message.dto';
import {SelfGuildMemberDto} from '../../../../../dtos/response/member.dto';
import {MessageType} from '../../../../../enums/message-type.enum';
import {hasPermission, Permissions} from '../../../../../enums/permissions.enum';
import {guildAbilities, unionMemberPermissions} from '../../../guild-permissions';
import {ModulePermissions} from '../../../../../enums/module-permissions.enum';
import {GuildFeature, guildHasFeature} from '../../../guild-features';
import {PersonaService} from '../../../../../services/persona.service';
import {SceneService} from '../../../../../services/scene.service';
import {SceneJoinRequestStatus, SceneStatus} from '../../../../../dtos/response/scene.dto';
import {isWaitingOnMe} from '../../../scenes/scene-status';
import {needsPermission} from '../../../scenes/scene-access';
import {turnClock} from '../../../scenes/scene-clock';
import {SceneConclusionComponent} from '../../../scenes/scene-conclusion/scene-conclusion.component';
import {SceneJoinDialogComponent} from '../../../scenes/scene-join-dialog/scene-join-dialog.component';
import {
    SceneJoinPrompt,
    SceneTurnPrompt,
} from '../../../../messaging/components/conversation/composer/composer.component';
import {buildMessageRows} from '../../../../messaging/components/conversation/message-utils';
import {sceneChannelIdFor} from '../channel-utils';
import {ChannelAccessBannerComponent} from '../channel-access-banner.component';
import {MlsUnreadableBannerComponent} from '../../../../../components/mls-unreadable-banner/mls-unreadable-banner.component';

import {TranslateModule, TranslateService} from '@ngx-translate/core';

import {MessageStore, withinWindow} from '../../../../../stores/message.store';
import {ProfileService} from '../../../../../services/profile.service';
import {GuildService} from '../../../../../services/guild.service';
import {OwnMemberRevisionService} from '../../../../../services/own-member-revision.service';
import {GuildWebsocketService} from '../../../../../services/guild-websocket.service';
import {GuildReadStateService} from '../../../../../services/guild-read-state.service';
import {TypingService} from '../../../../../services/typing.service';
import {BotCommandService} from '../../../../../services/bot-command.service';
import {ToastService} from '../../../../../services/toast.service';
import {ThreadRegistryService} from '../../../../../services/thread-registry.service';

import {ComposerComponent} from '../../../../messaging/components/conversation/composer/composer.component';
import {NavigationService} from '../../../../main-page/navigation.service';
import {MessageComponent} from '../../../../messaging/components/conversation/message/message.component';
import {SystemMessageComponent} from '../../../../messaging/components/conversation/message/system-message/system-message.component';
import {DateDividerComponent} from '../../../../messaging/components/conversation/date-divider/date-divider.component';
import {TypingDotsComponent} from '../../../../../components/typing-dots/typing-dots.component';
import {JumpToPresentComponent} from '../../../../../components/jump-to-present/jump-to-present.component';
import {CreateThreadDialogComponent} from '../create-thread-dialog/create-thread-dialog.component';
import {MessageScrollService} from '../../../../../shared/conversation/message-scroll.service';
import {ChannelEncryptionService} from './channel-encryption.service';
import {ChannelMessageDraft, ChannelSendService} from './channel-send.service';

/** The scrollback and the composer for one channel. Mounted twice: the main pane, and a thread panel beside it. */
@Component({
    selector: 'app-channel-conversation',
    host: {class: 'contents'},
    providers: [MessageScrollService, ChannelEncryptionService, ChannelSendService],
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
        SceneJoinDialogComponent,
        CreateThreadDialogComponent,
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
    protected scroll = inject(MessageScrollService);
    protected readonly encryption = inject(ChannelEncryptionService);
    protected readonly sending = inject(ChannelSendService);
    protected readonly scenes = inject(SceneService);
    protected readonly passing = signal(false);
    protected readonly joining = signal(false);
    protected readonly joinBusy = signal(false);

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

    /**
     * The character the next message would go out as, ignoring any proxy tag still being typed.
     * The strip is about this one and not the reader's whole roster: somebody playing Kaelen here
     * still needs the way in for Thessaly.
     */
    private readonly speakingAs = computed(
        () => this.personaService.resolveFor(this.guildId(), this.channel().id, '').personaId,
    );

    /** Whether the character about to speak is already in the scene. */
    private readonly inCast = computed(() => {
        const scene = this.scene();
        if (!scene) return false;

        const personaId = this.speakingAs();
        // Nobody chosen means the next message goes out as the account. Fall back to the roster so
        // a player writing out of character is not offered a way into a scene they are already in.
        if (!personaId) {
            const speakable = this.scenes.speakableIds(this.guildId());
            return scene.participants.some(participant => speakable.has(participant.personaId));
        }

        return scene.participants.some(participant => participant.personaId === personaId);
    });

    /**
     * The way into a scene this reader is not in. Null for the cast, who have a turn strip instead,
     * and for the companion thread, which anyone who can see the scene may already talk in.
     */
    protected readonly sceneJoin = computed((): SceneJoinPrompt | null => {
        const scene = this.scene();
        if (!scene || this.sceneSide() !== 'ic') return null;
        if (scene.status === SceneStatus.Concluded || this.inCast()) return null;

        const busy = this.joinBusy();
        const open = () => this.joining.set(true);

        if (!needsPermission(scene)) {
            return {state: 'open', reason: null, open, withdraw: null, busy};
        }

        const request = this.scenes.myRequest(scene.channelId);

        if (request?.status === SceneJoinRequestStatus.Pending) {
            return {
                state: 'pending',
                reason: null,
                open: null,
                withdraw: () => this.withdrawJoin(request.id),
                busy,
            };
        }

        if (request?.status === SceneJoinRequestStatus.Denied) {
            return {state: 'denied', reason: request.decisionReason ?? null, open, withdraw: null, busy};
        }

        return {state: 'ask', reason: null, open, withdraw: null, busy};
    });

    /** The out-of-character thread is deliberately unconstrained, so it never gets a strip. */
    protected readonly sceneTurn = computed((): SceneTurnPrompt | null => {
        const scene = this.scene();
        if (!scene || this.sceneSide() !== 'ic') return null;

        const quiet = (state: 'waiting' | 'paused' | 'concluded', name: string): SceneTurnPrompt => ({
            state,
            characterName: name,
            deadlineAt: null,
            overdue: false,
            pass: null,
            passing: false,
        });

        if (scene.status === SceneStatus.Concluded) return quiet('concluded', '');
        if (scene.status === SceneStatus.Paused) return quiet('paused', '');
        // Open means no rotation yet, so there is nothing to name.
        if (scene.status !== SceneStatus.Active || !scene.currentTurnPersonaId) return null;

        const participant = scene.participants.find(p => p.personaId === scene.currentTurnPersonaId);
        const identity = this.personaService.identity(
            this.guildId(),
            scene.currentTurnPersonaId,
            participant,
        );
        const characterName = identity?.name ?? '';

        if (!isWaitingOnMe(scene, this.scenes.speakableIds(this.guildId()))) {
            return quiet('waiting', characterName);
        }

        return {
            state: 'yours',
            characterName,
            deadlineAt: scene.turnDeadlineAt ?? null,
            overdue: turnClock(scene, this.scenes.now()).overdue,
            pass: () => this.passTurn(),
            passing: this.passing(),
        };
    });

    /** Ciphertext hides the proxy tag from the server, so the composer has to resolve it here. */
    protected readonly resolvePersonaLocally = computed(() => this.encryption.state() === 'joined');
    protected readonly replyingTo = signal<MessageDto | null>(null);

    protected get MessageType() {
        return MessageType;
    }

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

    /** Hidden, not disabled: a thread off an encrypted channel would be created in the clear. */
    protected readonly canCreateThreads = computed(() => {
        const ws = this.navService.workspace();
        if (ws.type !== 'server') return false;
        if (!guildHasFeature(ws.guild, GuildFeature.Threads)) return false;
        // Text, plus either half of a scene. Both hang directly off a text channel, which is as
        // deep as the server will start one; an ordinary thread does not offer it again.
        if (this.channel().type !== ChannelType.Text && !this.scene()) return false;
        if (this.encryption.state() !== 'plain') return false;
        const perms = this.threadPermissions();
        return (
            hasPermission(perms, Permissions.Superadmin) || hasPermission(perms, Permissions.CreateThreads)
        );
    });

    protected readonly threadStarter = signal<MessageDto | null>(null);
    protected readonly showCreateThread = signal(false);

    private readonly threadPermissions = computed(() => {
        const member = this.ownMember();
        if (!member) return 0n;
        return unionMemberPermissions(member);
    });

    private readonly channelWindow = computed(() => this.messageStore.channelMeta()[this.channel().id]);

    protected readonly messages = computed(() => {
        const meta = this.channelWindow();
        return this.messageStore
            .entities()
            .filter(m => m.channelId === this.channel().id && withinWindow(meta, m))
            .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    });
    protected readonly messageRows = computed(() => buildMessageRows(this.messages()));

    /** True while reading forward from somewhere behind the present. */
    protected readonly anchored = computed(() => this.channelWindow()?.anchored ?? false);

    protected readonly hasMore = computed(() => this.channelWindow()?.hasMore ?? false);
    protected readonly loadingMore = computed(
        () => this.messageStore.channelMeta()[this.channel().id]?.loadingMore ?? false,
    );
    protected readonly loadError = computed(
        () => this.messageStore.channelMeta()[this.channel().id]?.error ?? null,
    );

    private guildService = inject(GuildService);
    private ownMemberRevision = inject(OwnMemberRevisionService);
    private personaService = inject(PersonaService);
    private profileService = inject(ProfileService);
    private guildWs = inject(GuildWebsocketService);
    private readStateService = inject(GuildReadStateService);
    private typingService = inject(TypingService);
    private toastService = inject(ToastService);
    private translate = inject(TranslateService);
    private threadRegistry = inject(ThreadRegistryService);

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

    private readonly destroyRef = inject(DestroyRef);

    /** `channelId:messageId` of the last read cursor sent. Not a signal: nothing reads it. */
    private lastAck: string | null = null;

    constructor() {
        effect(onCleanup => {
            const channelId = this.channel().id;

            // Read-from-the-start is consumed once, here, so the next ordinary open of the same
            // channel lands at the present the way every other open does.
            if (untracked(() => this.navService.readFromStart()) === channelId) {
                this.navService.readFromStart.set(null);
                this.messageStore.loadChannelOldest(channelId);
            } else {
                this.messageStore.loadForChannel(channelId);
            }

            // Leaving takes the anchor with it: coming back to a channel is coming back to the
            // present unless read-from-the-start is asked for again.
            onCleanup(() => this.messageStore.clearChannelAnchor(channelId));
        });

        effect(() => {
            const channelId = this.channel().id;
            // Reconciles encryption before anything can be typed; also picks up a Welcome minted while we were away.
            void this.encryption.open(channelId);
            this.sending.autoModError.set(null);
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
            // Only a closed scene has a queue. The route narrows it, so a player gets their own row
            // and a GM the whole thing without either asking a different question.
            const scene = this.scene();
            if (!scene || !needsPermission(scene)) return;
            untracked(() => this.scenes.ensureRequests(this.guildId(), scene.channelId));
        });

        effect(() => {
            this.scroll.setAnchored(this.anchored());
        });

        effect(() => {
            const channelId = this.channel().id;
            const _ = this.messages();

            this.scroll.onMessagesChanged(channelId);
        });

        effect(() => {
            const _ = this.channel();
            setTimeout(() => this.composerRef?.focus(), 0);
        });

        afterEveryRender(() => {
            this.scroll.onRender(this.messageListRef?.nativeElement, this.scrollRef?.nativeElement);
        });

        effect(() => {
            const msgs = this.messages();
            const channelId = this.channel().id;
            if (msgs.length === 0) return;
            const latest = msgs[msgs.length - 1];
            if (latest.isPending || latest.isFailed) return;

            // The store holds every channel, so this effect re-runs on a message that arrived
            // somewhere else entirely. Two acks in flight at once for a channel with no read state
            // yet each insert their own row server-side, and the stale one keeps the channel unread
            // for good.
            const ack = `${channelId}:${latest.id}`;
            if (this.lastAck !== ack) {
                this.lastAck = ack;
                void this.guildWs.updateLastReadMessageByChannel(latest.id, channelId);
            }

            this.readStateService.markChannelRead(channelId);
        });

        this.watchThreadAttachments();
    }

    private watchThreadAttachments(): void {
        this.guildWs.messageThreadAttachedObservable
            .pipe(takeUntilDestroyed(this.destroyRef))
            .subscribe(e => {
                if (e.channelId !== untracked(() => this.channel().id)) return;
                this.messageStore.attachThread(e.messageId, e.threadId);
            });
    }

    ngAfterViewInit(): void {
        const el = this.scrollRef?.nativeElement;
        if (el) this.scroll.attach(el);
        this.scroll.scrollToBottom();
    }

    public createMessage(draft: ChannelMessageDraft): void {
        this.replyingTo.set(null);
        this.sending.submit(this.channel(), draft);
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

    /** Takes back an ask the GM has not answered. The event clears the row; this clears the wait. */
    protected withdrawJoin(requestId: string): void {
        const scene = this.scene();
        if (!scene || this.joinBusy()) return;
        this.joinBusy.set(true);
        this.scenes.withdrawRequest(this.guildId(), scene.channelId, requestId).subscribe({
            next: () => this.joinBusy.set(false),
            error: err => {
                this.joinBusy.set(false);
                this.toastService.httpError(this.translate.instant('SCENE.TOAST.FAILED'), err);
            },
        });
    }

    // ── Scroll handling ──────────────────────────────────────────────────────

    protected onScroll(): void {
        this.scroll.onScroll({
            hasMore: this.hasMore(),
            loadingMore: this.loadingMore(),
            onLoadMore: () => this.messageStore.loadMoreForChannel(this.channel().id),
            onLoadNewer: () => this.messageStore.loadNewerForChannel(this.channel().id),
        });
    }

    public jumpToMessage(messageId: string): void {
        // Delay until the message list re-renders after the caller clears search.
        setTimeout(() => this.scroll.jumpToMessage(messageId), 50);
    }

    /** From an anchored window the present is not in the DOM to scroll to, so the anchor is dropped and the newest page read. */
    protected jumpToPresent(): void {
        if (this.scroll.jumpToPresent()) return;
        const channelId = this.channel().id;
        this.messageStore.clearChannelAnchor(channelId);
        this.messageStore.loadForChannel(channelId);
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

    protected onCreateThread(message: MessageDto): void {
        const existing = message.threadId;
        if (existing) {
            this.openThreadById(existing);
            return;
        }
        this.threadStarter.set(message);
        this.showCreateThread.set(true);
    }

    /** The registry answers from the guild payload where it can, so the panel usually opens without a round trip. */
    protected openThreadById(threadId: string): void {
        const held = this.threadRegistry.thread(threadId);
        if (held) {
            this.navService.openThread(held);
            return;
        }
        this.guildService.getChannel(threadId).subscribe({
            next: thread => {
                this.threadRegistry.upsert(thread);
                this.navService.openThread(thread);
            },
            error: err => this.toastService.httpError(this.translate.instant('THREAD.CREATE_ERROR'), err),
        });
    }

    protected onTyping(): void {
        this.guildWs.invokeStartTyping(this.channel().id);
    }
}
