import {animate, query, stagger, style, transition, trigger} from '@angular/animations';
import {
    Component,
    computed,
    DestroyRef,
    effect,
    ElementRef,
    inject,
    output,
    signal,
    viewChild,
    ViewChild,
} from '@angular/core';
import {toObservable} from '@angular/core/rxjs-interop';
import {filter, take} from 'rxjs';
import {DatePipe, NgClass} from '@angular/common';
import {ContextMenu} from 'primeng/contextmenu';
import {ConfirmDialog} from 'primeng/confirmdialog';
import {ConfirmationService, MenuItem} from 'primeng/api';

import {ConversationDto} from '../../../../dtos/response/conversation.dto';
import {MessageDto} from '../../../../dtos/response/message.dto';
import {MessageEncryptionState} from '../../../../enums/message-encryption-state.enum';

import {ConversationAvatarComponent} from '../conversation-avatar/conversation-avatar.component';
import {UserStatusDotComponent} from '../../../../components/user-status-dot/user-status-dot.component';
import {TypingDotsComponent} from '../../../../components/typing-dots/typing-dots.component';
import {EmptyStateComponent} from '../../../../components/empty-state/empty-state.component';

import {ProfileService} from '../../../../services/profile.service';
import {MessagingService} from '../../../../services/messaging.service';
import {ConversationService} from '../../../../services/conversation.service';
import {MessagingWebsocketService} from '../../../../services/messaging-websocket.service';
import {ConversationUtilsService} from '../../../../services/conversation-utils.service';
import {MlsService} from '../../../../services/mls.service';
import {MlsSyncService} from '../../../../services/mls-sync.service';

import {ConversationStore} from '../../../../stores/conversation.store';
import {MessageStore} from '../../../../stores/message.store';

import {ToastService} from '../../../../services/toast.service';
import {NavigationService} from '../../../main-page/navigation.service';
import {OsInfo} from '../../../../platform/ports/os-info.port';
import {TranslateModule} from '@ngx-translate/core';
import {decodeBody, UNDECRYPTABLE_SHORT} from '../../../../helpers/message-content.helper';

const PREVIEW_SIZE = 30;

@Component({
    selector: 'app-conversation-list',
    imports: [
        ConversationAvatarComponent,
        DatePipe,
        NgClass,
        UserStatusDotComponent,
        TypingDotsComponent,
        EmptyStateComponent,
        ContextMenu,
        ConfirmDialog,
        TranslateModule,
    ],
    providers: [ConfirmationService],
    templateUrl: './conversation-list.component.html',
    styleUrl: './conversation-list.component.css',
    animations: [
        trigger('convList', [
            transition(':increment, :decrement, * => *', [
                query(
                    ':enter',
                    [
                        style({opacity: 0, transform: 'translateY(-6px) scale(0.98)'}),
                        stagger(40, [
                            animate(
                                '220ms cubic-bezier(0.4, 0, 0.2, 1)',
                                style({opacity: 1, transform: 'translateY(0) scale(1)'}),
                            ),
                        ]),
                    ],
                    {optional: true},
                ),
                query(
                    ':leave',
                    [animate('160ms ease-in', style({opacity: 0, transform: 'translateX(8px)'}))],
                    {optional: true},
                ),
            ]),
        ]),
    ],
})
export class ConversationListComponent {
    public conversationSelected = output<ConversationDto>();
    public os = inject(OsInfo);
    readonly sortKey = computed(() =>
        this.sortedConversations()
            .map(c => c.id)
            .join(','),
    );
    // whenever the open conversation loads its full message history.
    readonly previewMessages = signal<Map<string, MessageDto[]>>(new Map());
    // messages and via direct decode for WS-received messages (already decrypted in content).
    readonly decryptedPreviews = signal<Map<string, string>>(new Map());
    // ── Conversation context menu ─────────────────────────────────────────────
    @ViewChild('convMenu') convMenu!: ContextMenu;
    /** The mobile paging sentinel, present only while `hasMore()` is true. */
    private readonly loadMoreSentinel = viewChild<ElementRef<HTMLElement>>('loadMoreSentinel');
    protected conversationStore = inject(ConversationStore);
    readonly sortedConversations = computed(() =>
        [...this.conversationStore.entities()].sort(
            (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
        ),
    );
    protected convUtils = inject(ConversationUtilsService);
    protected readonly contextConv = signal<ConversationDto | null>(null);
    private navService = inject(NavigationService);
    readonly selectedId = computed(() => {
        const view = this.navService.mainView();
        return view.type === 'conversation' ? view.conversation.id : null;
    });
    private profileService = inject(ProfileService);
    // Does NOT read from MessageStore: that was the source of the UI freeze.
    readonly unreadCounts = computed(() => {
        const ownId = this.profileService.ownProfile()?.userId;
        const prevMap = this.previewMessages();
        const result = new Map<string, number>();

        for (const conv of this.conversationStore.entities()) {
            const ownMember = conv.members.find(m => m.userId === ownId);
            const lastReadId = ownMember?.lastReadMessageId;
            // msgs are newest-first; index 0 is the most recent message.
            const msgs = prevMap.get(conv.id) ?? [];

            if (!lastReadId) {
                result.set(conv.id, msgs.length);
            } else {
                const readIdx = msgs.map(m => m.id).indexOf(lastReadId);
                // readIdx === -1: lastRead is older than all previewed messages → all PREVIEW_SIZE unread.
                // readIdx === 0: newest message is already read → 0 unread.
                // readIdx === N: N messages newer than the last-read position.
                result.set(conv.id, readIdx === -1 ? msgs.length : readIdx);
            }
        }

        return result;
    });
    private messagingService = inject(MessagingService);
    private conversationService = inject(ConversationService);

    // Per-conversation preview: last PREVIEW_SIZE messages, newest first.
    // Used for the last-message preview text, timestamp, and unread count.
    // Intentionally separate from MessageStore to avoid the list recomputing
    private messageStore = inject(MessageStore);
    // Decrypted plaintext per message id, populated async from MLS cache for HTTP-loaded
    private toast = inject(ToastService);

    // Unread count per conversation.
    // Only depends on previewMessages + conversationStore (for lastReadMessageId).
    private messagingWs = inject(MessagingWebsocketService);
    private mlsService = inject(MlsService);
    private mlsSync = inject(MlsSyncService);
    private confirmationService = inject(ConfirmationService);

    constructor() {
        this.observeLoadMoreSentinel();
        this.conversationStore.loadInitial();

        toObservable(this.conversationStore.loaded)
            .pipe(
                filter(loaded => loaded),
                take(1),
            )
            .subscribe(() => {
                this.navService.tryRestoreConversationNav(this.conversationStore.entities());
            });

        // Prepend new messages to the preview window (keeps newest-first order).
        const prependPreview = (msg: MessageDto) => {
            if (!msg.conversationId) return;
            this.previewMessages.update(map => {
                const existing = map.get(msg.conversationId!) ?? [];
                const updated = [msg, ...existing].slice(0, PREVIEW_SIZE);
                return new Map(map).set(msg.conversationId!, updated);
            });
        };
        this.messagingWs.messageObservable.subscribe(prependPreview);
        this.messagingService.messageSentObservable.subscribe(prependPreview);

        // Fetch the initial preview for any conversation not yet loaded.
        effect(() => {
            const convs = this.conversationStore.entities();
            const loaded = this.previewMessages();
            convs
                .filter(c => !loaded.has(c.id))
                .forEach(c => {
                    this.messagingService
                        .getMessagesForConversation(c.id, 0, PREVIEW_SIZE)
                        .subscribe(async msgs => {
                            // API returns messages ascending (oldest-first); reverse so index 0 is always the newest,
                            // consistent with the websocket prepend behaviour.
                            const reversed = [...msgs].reverse();
                            this.previewMessages.update(map => new Map(map).set(c.id, reversed));
                            // Populate decrypted preview text from MLS cache for encrypted messages.
                            for (const msg of reversed) {
                                if (msg.encryptionState === MessageEncryptionState.Encrypted) {
                                    // Context, generation and claimed author all go into the lookup:
                                    // the cache is keyed on more than the server-chosen `messageId`
                                    // precisely so a preview cannot pick up another conversation's
                                    // plaintext for a replayed id.
                                    const cached = await this.mlsService.getCachedMessage(
                                        c.id,
                                        msg.mlsGeneration ?? null,
                                        msg.id,
                                        msg.authorId,
                                    );
                                    if (cached) {
                                        try {
                                            const bytes = Uint8Array.from(atob(cached), c => c.charCodeAt(0));
                                            const text = new TextDecoder('utf-8', {fatal: true})
                                                .decode(bytes)
                                                .replace(/@([\w\-.]+)#\w+/g, '@$1');
                                            this.decryptedPreviews.update(m => new Map(m).set(msg.id, text));
                                        } catch {}
                                    }
                                }
                            }
                        });
                });
        });
    }

    public getPreview(conv: ConversationDto): {sender: string; text: string} | null {
        const msg = this.previewMessages().get(conv.id)?.[0]; // [0] is newest
        if (!msg) return null;

        const ownId = this.profileService.ownProfile()?.userId;
        const sender =
            msg.authorId === ownId
                ? 'You'
                : (conv.members.find(m => m.userId === msg.authorId)?.cachedUserName ?? 'Unknown');

        // Before anything is decoded, and for encrypted and plaintext alike. The sidebar reads the
        // same `content` the bubble does, so suppressing an unverified body in the thread and not
        // here would just move the injected text three inches to the left.
        if (msg.undecryptable) return {sender, text: UNDECRYPTABLE_SHORT};

        if (msg.encryptionState === MessageEncryptionState.Encrypted) {
            // HTTP-loaded messages resolved from MLS cache (async populated).
            const cached = this.decryptedPreviews().get(msg.id);
            if (cached) return {sender, text: cached};
            // WS-received messages already have decrypted content; ciphertext is binary
            // and won't survive a strict UTF-8 decode, so use that as the gate.
            try {
                const bytes = Uint8Array.from(atob(msg.content), c => c.charCodeAt(0));
                const text = new TextDecoder('utf-8', {fatal: true})
                    .decode(bytes)
                    .replace(/@([\w\-.]+)#\w+/g, '@$1');
                return {sender, text};
            } catch {
                return {sender, text: '🔒 Encrypted message'};
            }
        }

        const text = decodeBody(msg.content).replace(/@([\w\-.]+)#\w+/g, '@$1');

        return {sender, text};
    }

    public getUnreadCount(convId: string): number {
        return this.unreadCounts().get(convId) ?? 0;
    }

    /** Asks for the next page when the sentinel scrolls into view. */
    protected requestNextPage(): void {
        if (!this.conversationStore.hasMore() || this.conversationStore.loading()) return;
        this.conversationStore.loadMore();
    }

    /** Watches the sentinel for as long as one is rendered. */
    private observeLoadMoreSentinel(): void {
        // jsdom has no IntersectionObserver, and neither does an old webview. Paging simply does
        // not auto-trigger there - it must not throw and take the conversation list with it.
        if (typeof IntersectionObserver === 'undefined') return;

        const observer = new IntersectionObserver(
            entries => {
                if (entries.some(entry => entry.isIntersecting)) this.requestNextPage();
            },
            // A margin, so the next page starts loading just before the sentinel is actually
            // reached - the same "fetch slightly early" behaviour ion-infinite-scroll had by
            // default, and the difference between a seamless list and a visible stall.
            {rootMargin: '200px'},
        );

        effect(() => {
            const sentinel = this.loadMoreSentinel();
            observer.disconnect();
            if (sentinel) observer.observe(sentinel.nativeElement);
        });

        inject(DestroyRef).onDestroy(() => observer.disconnect());
    }

    public deleteConversation(conv: ConversationDto, event?: MouseEvent): void {
        event?.stopPropagation();
        const name = this.convUtils.getChatTitle(conv);
        this.confirmationService.confirm({
            message: `Are you sure you want to delete the conversation with <strong>${name}</strong>? This cannot be undone.`,
            header: 'Delete Conversation',
            icon: 'pi pi-trash',
            acceptLabel: 'Delete',
            rejectLabel: 'Cancel',
            acceptButtonProps: {severity: 'danger', size: 'small'},
            rejectButtonProps: {severity: 'secondary', outlined: true, size: 'small'},
            accept: () => {
                // Leave the MLS group first. It drops this device's keys immediately, so even if
                // the server call below fails we have already given up the ability to read anything
                // sent afterwards - which is the half that matters for our own forward secrecy.
                // Doing it after would leave the keys behind whenever the request failed.
                void this.mlsSync
                    .leaveContext(conv.id, false)
                    .catch(err => console.error('Could not leave the MLS group', conv.id, err))
                    .finally(() => {
                        this.conversationService.deleteConversation(conv.id).subscribe({
                            next: () => {
                                this.conversationStore.removeConversation(conv.id);
                                this.messageStore.removeMessagesForConversation(conv.id);
                                if (this.selectedId() === conv.id) {
                                    this.navService.showHome();
                                }
                                this.toast.success('Conversation deleted', {detail: name});
                            },
                            error: err => this.toast.httpError('Failed to delete conversation', err),
                        });
                    });
            },
        });
    }

    protected onConvContextMenu(event: MouseEvent, conv: ConversationDto): void {
        event.preventDefault();
        event.stopPropagation();
        this.contextConv.set(conv);
        this.convMenu.model = this.buildConvMenuItems(conv);
        this.convMenu.show(event);
    }

    private buildConvMenuItems(conv: ConversationDto): MenuItem[] {
        return [
            {
                label: 'Open',
                icon: 'pi pi-comment',
                command: () => this.conversationSelected.emit(conv),
            },
            {separator: true},
            {
                label: 'Mark as Read',
                icon: 'pi pi-check',
            },
            {
                label: 'Mute Notifications',
                icon: 'pi pi-bell-slash',
            },
            {separator: true},
            {
                label: 'Delete Conversation',
                icon: 'pi pi-trash',
                styleClass: '!text-rose-400',
                command: () => this.deleteConversation(conv),
            },
        ];
    }
}
