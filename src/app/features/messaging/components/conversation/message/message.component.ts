import {
  ChangeDetectionStrategy, Component, computed, DestroyRef, ElementRef, HostListener, inject, input, output, signal,
  viewChild, ViewChild
} from '@angular/core';
import {takeUntilDestroyed, toObservable, toSignal} from '@angular/core/rxjs-interop';
import {MessageAttachment, MessageDto} from "../../../../../dtos/response/message.dto";
import {AppAvatarComponent} from "../../../../../components/avatar/avatar.component";
import {AsyncPipe, DatePipe, NgClass} from "@angular/common";
import {ProfileService} from "../../../../../services/profile.service";
import {Observable, of, switchMap} from "rxjs";
import {ProfileDto} from "../../../../../dtos/response/profile.dto";
import { isKlipyGifUrl } from '../../../../../services/gif.service';
import { EmojiDataService, getFlagCode, isRegionalIndicator } from '../../../../../services/emoji-data.service';
import { MarkdownPipe } from '../../../../../pipes/markdown.pipe';
import { AttachmentDto, FileService } from '../../../../../services/file.service';
import { MessagingService } from '../../../../../services/messaging.service';
import { MessageStore } from '../../../../../stores/message.store';
import { ProfileDialogService } from '../../../../../services/profile-dialog.service';
import { openUrl } from '@tauri-apps/plugin-opener';

@Component({
  selector: 'app-message',
  imports: [
    AppAvatarComponent,
    DatePipe,
    AsyncPipe,
    NgClass,
    MarkdownPipe,
  ],
  templateUrl: './message.component.html',
  styleUrl: './message.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MessageComponent {
  protected readonly openUrl = openUrl;

  public profileService = inject(ProfileService);
  private emojiDataService = inject(EmojiDataService);
  private fileService = inject(FileService);
  private messagingService = inject(MessagingService);
  private messageStore = inject(MessageStore);
  protected profileDialogSvc = inject(ProfileDialogService);

  private destroyRef = inject(DestroyRef);

  @ViewChild('editArea') private editAreaRef?: ElementRef<HTMLTextAreaElement>;

  lightbox = signal<{ loading: boolean; att: AttachmentDto | null; name: string } | null>(null);

  @HostListener('document:keydown.escape')
  closeLightbox(): void {
    this.lightbox.set(null);
    this.longPressMenu.set(false);
  }

  onTouchStart(): void {
    this.longPressTimer = setTimeout(() => {
      this.longPressMenu.set(true);
      this.longPressTimer = null;
      if ('vibrate' in navigator) navigator.vibrate(30);
    }, 500);
  }

  onTouchMove(): void {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  onTouchEnd(): void {
    if (this.longPressTimer !== null) {
      clearTimeout(this.longPressTimer);
      this.longPressTimer = null;
    }
  }

  onLongPressReply(): void {
    this.longPressMenu.set(false);
    this.reply.emit(this.message());
  }

  onLongPressEdit(): void {
    this.longPressMenu.set(false);
    this.startEdit();
  }

  onLongPressDelete(): void {
    this.longPressMenu.set(false);
    this.confirmDelete();
  }

  openLightbox(minimal: MessageAttachment): void {
    this.lightbox.set({ loading: true, att: null, name: minimal.fileName });
    this.fileService.getAttachmentMetadataById(minimal.id).subscribe({
      next: att => this.lightbox.update(s => s ? { ...s, loading: false, att } : s),
      error: () => this.lightbox.set(null),
    });
  }

  download(att: { id: string; fileName: string }): void {
    this.fileService.downloadAttachmentById(att.id).subscribe(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = att.fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  }

  fileIcon(contentType: string): string {
    if (contentType.startsWith('video/')) return 'pi-video';
    if (contentType.startsWith('audio/')) return 'pi-volume-up';
    if (contentType === 'application/pdf') return 'pi-file-pdf';
    if (contentType.includes('zip') || contentType.includes('rar') || contentType.includes('tar')) return 'pi-folder';
    if (contentType.startsWith('text/')) return 'pi-file-edit';
    return 'pi-file';
  }

  fileIconColor(contentType: string): string {
    if (contentType.startsWith('video/')) return 'text-purple-400';
    if (contentType.startsWith('audio/')) return 'text-emerald-400';
    if (contentType === 'application/pdf') return 'text-rose-400';
    if (contentType.includes('zip') || contentType.includes('rar')) return 'text-amber-400';
    if (contentType.startsWith('text/')) return 'text-sky-400';
    return 'text-white/40';
  }

  public message = input.required<MessageDto>();

  public reply = output<MessageDto>();
  public jumpTo = output<string>();

  public content = computed(() => {
    const bytes = Uint8Array.from(atob(this.message().content), c => c.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    return this.emojiDataService.resolveShortcodes(decoded);
  });

  public isOnlyEmoji = computed(() => {
    const content = this.content().trim().replace(/ /g,'')

    // 30 is the new 15 btw
    if(content.length > 30) return false;
    if (content.length === 0) return false;
    if ([...content].some(isRegionalIndicator)) return false;

    return /^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F?|\u200D)+$/u.test(content);
  });

  public contentSegments = computed(() => {
    const text = this.content();
    let segments: { type: 'text' | 'mention' | 'gif' | 'emoji' | 'flag'; value: string }[] = [];

    // If the entire message is a GIF URL, render it as a single GIF segment
    if (isKlipyGifUrl(text)) {
      return [{ type: 'gif' as const, value: text.trim() }];
    }

    const regex = /@[\w\-.]+#\w+/g;
    let last = 0;
    let match;

    // 1. Extract mentions and text
    while ((match = regex.exec(text)) !== null) {
      if (match.index > last) {
        segments.push({ type: 'text', value: text.slice(last, match.index) });
      }
      segments.push({ type: 'mention', value: match[0] });
      last = match.index + match[0].length;
    }
    if (last < text.length) {
      segments.push({ type: 'text', value: text.slice(last) });
    }

    // 2. Process text segments to separate single emojis
    const finalSegments: { type: 'text' | 'mention' | 'gif' | 'emoji' | 'flag'; value: string }[] = [];

    const emojiRegex = /^(?=\p{Emoji})(?!\p{Number}).$/u;

    for (const segment of segments) {
      if (segment.type === 'text') {
        const chars = [...segment.value];
        let currentText = '';

        for (let i = 0; i < chars.length; i++) {
          const char = chars[i];
          if (isRegionalIndicator(char)) {
            const next = chars[i + 1];
            const code = next ? getFlagCode(char, next) : null;
            if (code) {
              if (currentText.length > 0) {
                finalSegments.push({ type: 'text', value: currentText });
                currentText = '';
              }
              finalSegments.push({ type: 'flag', value: code });
              i++;
              continue;
            }
          }
          if (emojiRegex.test(char)) {
            if (currentText.length > 0) {
              finalSegments.push({ type: 'text', value: currentText });
              currentText = '';
            }
            finalSegments.push({ type: 'emoji', value: char });
          } else {
            currentText += char;
          }
        }

        if (currentText.length > 0) {
          finalSegments.push({ type: 'text', value: currentText });
        }
      } else {
        finalSegments.push(segment);
      }
    }

    return finalSegments;
  });




  private readonly replyCtx = computed(() => ({
    id: this.message().inReplyTo,
    conversationId: this.message().conversationId,
    channelId: this.message().channelId,
  }));

  protected readonly replyMessage = toSignal(
    toObservable(this.replyCtx).pipe(
      switchMap(ctx => ctx.id
        ? this.messageStore.getOrFetchMessage(ctx.id, { conversationId: ctx.conversationId, channelId: ctx.channelId })
        : of(null as MessageDto | null)
      )
    ),
    { initialValue: null as MessageDto | null }
  );

  protected readonly replyAuthorName = computed(() => {
    const msg = this.replyMessage();
    if (!msg) return '';
    if (msg.authorId === this.profileService.ownProfile()?.userId) return 'You';
    return this.profileService.getCachedByUserId(msg.authorId)?.userName ?? 'Unknown';
  });

  protected readonly replySnippet = computed(() => {
    const msg = this.replyMessage();
    if (!msg) return '';
    try {
      const bytes = Uint8Array.from(atob(msg.content), c => c.charCodeAt(0));
      return new TextDecoder().decode(bytes).slice(0, 80);
    } catch { return ''; }
  });

  readonly isOwn = computed(() =>
    this.message().authorId === this.profileService.ownProfile()?.userId
  );

  readonly longPressMenu = signal(false);
  private longPressTimer: ReturnType<typeof setTimeout> | null = null;

  readonly isEditing = signal(false);
  readonly editText = signal('');
  readonly saving = signal(false);
  readonly showDeleteConfirm = signal(false);

  startEdit(): void {
    this.editText.set(this.content());
    this.isEditing.set(true);
    setTimeout(() => {
      const el = this.editAreaRef?.nativeElement;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
        this.autoResize(el);
      }
    }, 0);
  }

  cancelEdit(): void {
    this.isEditing.set(false);
    this.showDeleteConfirm.set(false);
  }

  saveEdit(): void {
    const text = this.editText().trim();
    if (!text || this.saving()) return;
    this.saving.set(true);
    this.isEditing.set(false);
    this.messagingService.updateMessage(this.message().id, text)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: updated => {
          this.messageStore.applyMessageUpdate(updated);
          this.saving.set(false);
        },
        error: () => {
          this.saving.set(false);
          this.editText.set(text);
          this.isEditing.set(true);
        },
      });
  }

  confirmDelete(): void {
    this.showDeleteConfirm.set(true);
  }

  deleteMessage(): void {
    this.showDeleteConfirm.set(false);
    this.messagingService.deleteMessage(this.message().id).subscribe({
      next: () => this.messageStore.removeMessage(this.message().id),
    });
  }

  onEditEnter(event: Event): void {
    const ke = event as KeyboardEvent;
    if (!ke.shiftKey) {
      event.preventDefault();
      this.saveEdit();
    }
  }

  autoResize(el: HTMLTextAreaElement): void {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 240) + 'px';
  }

  onLinkClick(event: MouseEvent): void {
    const anchor = (event.target as HTMLElement).closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href) return;
    event.preventDefault();
    openUrl(href);
  }

  public getProfile(): Observable<ProfileDto>{
    return this.profileService.getByUserId(this.message().authorId);
  }
}
