import {
  AfterViewInit,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  output,
  ViewChild,
  viewChildren,
} from '@angular/core';
import { ConversationDto } from '../../../../dtos/response/conversation.dto';
import { ComposerComponent } from './composer/composer.component';
import { MessageComponent } from './message/message.component';
import { Avatar } from 'primeng/avatar';
import { Button } from 'primeng/button';
import { MessagingService } from '../../../../services/messaging.service';
import { MessageStore } from '../../../../stores/message.store';
import { catchError, EMPTY, tap } from 'rxjs';
import { ProfileService } from '../../../../services/profile.service';
import { MessageDto } from '../../../../dtos/response/message.dto';

const SCROLL_BOTTOM_THRESHOLD = 100; // px from bottom — auto-scroll kicks in
const LOAD_MORE_THRESHOLD = 150;     // px from top — fetch older messages

@Component({
  selector: 'app-conversation',
  imports: [ComposerComponent, MessageComponent, Avatar, Button],
  templateUrl: './conversation.component.html',
  styleUrl: './conversation.component.css',
})
export class ConversationComponent implements AfterViewInit {
  public conversation = input.required<ConversationDto>();
  public back = output();

  private messageStore = inject(MessageStore);
  private messagingService = inject(MessagingService);
  private profileService = inject(ProfileService);

  @ViewChild('messageScroll') private scrollRef!: ElementRef<HTMLDivElement>;

  /** Tracks rendered <app-message> instances — updates only after the @for DOM is committed */
  private renderedMessages = viewChildren(MessageComponent);

  /** Whether the user is close enough to the bottom that we should auto-scroll on new messages */
  private isNearBottom = true;

  /** Saved scrollHeight before an older-message fetch, used to restore position after DOM update */
  private savedScrollHeight = 0;

  /** Set to true when we need to restore scroll position after older messages load */
  private restoreScroll = false;

  // ── Derived signals ──────────────────────────────────────────────────────

  protected messages = computed(() =>
    this.messageStore
      .entities()
      .filter(m => m.conversationId === this.conversation().id)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  );

  protected hasMore = computed(() =>
    this.messageStore.conversationMeta()[this.conversation().id]?.hasMore ?? false
  );

  protected loadingMore = computed(() =>
    this.messageStore.conversationMeta()[this.conversation().id]?.loadingMore ?? false
  );

  // ── Lifecycle ────────────────────────────────────────────────────────────

  constructor() {
    // Switch conversation → initial fetch + reset scroll state
    effect(() => {
      this.messageStore.loadForConversation(this.conversation().id);
      this.isNearBottom = true;
      this.restoreScroll = false;
    });

    // React after the @for DOM nodes are committed (viewChildren updates post-render)
    effect(() => {
      const _ = this.renderedMessages(); // track — fires only after DOM is ready

      if (this.restoreScroll) {
        // Older messages were prepended — restore position so the view doesn't jump
        if (!this.scrollRef) return;
        const el = this.scrollRef.nativeElement;
        const heightDiff = el.scrollHeight - this.savedScrollHeight;
        if (heightDiff > 0) el.scrollTop += heightDiff;
        this.restoreScroll = false;
        this.savedScrollHeight = 0;
      } else if (this.isNearBottom) {
        this.scrollToBottom();
      }
    });
  }

  ngAfterViewInit(): void {
    this.scrollToBottom();
  }

  // ── Scroll handling ──────────────────────────────────────────────────────

  protected onScroll(): void {
    const el = this.scrollRef.nativeElement;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    this.isNearBottom = fromBottom < SCROLL_BOTTOM_THRESHOLD;

    // Near the top → fetch older messages
    if (el.scrollTop < LOAD_MORE_THRESHOLD && this.hasMore() && !this.loadingMore()) {
      this.savedScrollHeight = el.scrollHeight;
      this.restoreScroll = true;
      this.messageStore.loadMoreForConversation(this.conversation().id);
    }
  }

  private scrollToBottom(): void {
    if (!this.scrollRef) return;
    const el = this.scrollRef.nativeElement;
    el.scrollTop = el.scrollHeight;
  }

  // ── Actions ──────────────────────────────────────────────────────────────

  public createMessage(content: string): void {
    const tempId = crypto.randomUUID();
    const now = new Date();

    const optimistic: MessageDto = {
      id:             tempId,
      content : btoa(content),
      conversationId: this.conversation().id,
      channelId:      undefined,
      authorId:       this.profileService.ownProfile()?.userId ?? '',
      createdAt:      now,
      updatedAt:      now,
      isPending:      true,
      isFailed:       false,
    };

    this.messageStore.addMessage(optimistic);

    this.messagingService.createMessage({
      content,
      channelId:      undefined,
      conversationId: this.conversation().id,
    }).pipe(
      tap(confirmed => this.messageStore.confirmMessage(tempId, confirmed)),
      catchError(() => {
        this.messageStore.failMessage(tempId);
        return EMPTY;
      }),
    ).subscribe();
  }
}
