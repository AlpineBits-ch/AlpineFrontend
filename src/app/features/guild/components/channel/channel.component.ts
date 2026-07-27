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
import {catchError, debounceTime, EMPTY, Subject, tap} from 'rxjs';

import {ChannelDto, ChannelType} from '../../../../dtos/response/guild.dto';
import {MessageAttachment, MessageDto} from '../../../../dtos/response/message.dto';
import {MessageEncryptionState} from '../../../../enums/message-encryption-state.enum';
import {MessageType} from '../../../../enums/message-type.enum';

import {Button} from 'primeng/button';

import {MessagingService} from '../../../../services/messaging.service';
import {MessageStore} from '../../../../stores/message.store';
import {ProfileService} from '../../../../services/profile.service';
import {GuildWebsocketService} from '../../../../services/guild-websocket.service';
import {GuildReadStateService} from '../../../../services/guild-read-state.service';
import {TypingService} from '../../../../services/typing.service';

import {ComposerComponent} from '../../../messaging/components/conversation/composer/composer.component';
import {NavigationService} from '../../../main-page/navigation.service';
import {MessageComponent} from '../../../messaging/components/conversation/message/message.component';
import {HighlightPipe} from '../../../../pipes/highlight.pipe';
import {TypingDotsComponent} from '../../../../components/typing-dots/typing-dots.component';
import {ThreadPanelComponent} from './thread-panel/thread-panel.component';

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
        ComposerComponent, MessageComponent, Button,
        DatePipe, HighlightPipe, TypingDotsComponent, ThreadPanelComponent,
    ],
    templateUrl: './channel.component.html',
    styleUrl: './channel.component.css',
})
export class ChannelComponent implements AfterViewInit {
    public channel = input.required<ChannelDto>();
    public back = output();
    protected navService = inject(NavigationService);
    protected guildId = computed(() => this.channel().guildId);
    protected guildRoles = computed(() => {
        const ws = this.navService.workspace();
        return ws.type === 'server' ? ws.guild.roles : [];
    });
    protected guildChannels = computed(() => {
        const ws = this.navService.workspace();
        return ws.type === 'server' ? ws.guild.channels : [];
    });
    protected replyingTo = signal<MessageDto | null>(null);
    protected showThreadPanel = signal(false);
    protected readonly ChannelType = ChannelType;
    protected searchQuery = signal('');
    protected isSearchActive = computed(() => this.searchQuery().trim().length > 0);
    protected isSearching = computed(() => this.searchEntry()?.searching ?? false);
    protected msgResults = computed(() => {
        const q = this.searchQuery().trim().toLowerCase();
        if (!q) return [];
        return (this.searchEntry()?.results ?? []).filter(m =>
            decodeContent(m.content).toLowerCase().includes(q)
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
    protected messages = computed(() =>
        this.messageStore
            .entities()
            .filter(m => m.channelId === this.channel().id)
            .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    );

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
    private profileService = inject(ProfileService);
    private guildWs = inject(GuildWebsocketService);
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
            //console.log(this.messages());
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

        this.replyingTo.set(null);

        const optimistic: MessageDto = {
            id: tempId,
            content: btoa(encodeURIComponent(content).replace(/%([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))),
            channelId: this.channel().id,
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

        this.messagingService.createMessage({
            content,
            channelId: this.channel().id,
            conversationId: undefined,
            attachments,
            inReplyTo,
            mentions,
            roleMentions,
            mentionsEveryone,
            mentionsHere,
        }).pipe(
            tap(confirmed => {
                this.messageStore.confirmMessage(tempId, confirmed);
                this.messagingService.messageSentObservable.next(confirmed);
            }),
            catchError(() => {
                this.messageStore.failMessage(tempId);
                return EMPTY;
            }),
        ).subscribe();
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

    protected getSnippet(encoded: string): string {
        return decodeContent(encoded);
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
