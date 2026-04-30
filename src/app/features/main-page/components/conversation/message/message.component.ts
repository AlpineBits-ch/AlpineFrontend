import {ChangeDetectionStrategy, Component, computed, DestroyRef, ElementRef, HostListener, inject, input, signal, ViewChild} from '@angular/core';
import {takeUntilDestroyed} from '@angular/core/rxjs-interop';
import {MessageAttachment, MessageDto} from "../../../../../dtos/response/message.dto";
import {AppAvatarComponent} from "../../../../../components/avatar/avatar.component";
import {AsyncPipe, DatePipe, NgClass} from "@angular/common";
import {ProfileService} from "../../../../../services/profile.service";
import {Observable} from "rxjs";
import {ProfileDto} from "../../../../../dtos/response/profile.dto";
import { isKlipyGifUrl } from '../../../../../services/gif.service';
import { EmojiDataService } from '../../../../../services/emoji-data.service';
import { MarkdownPipe } from '../../../../../pipes/markdown.pipe';
import { AttachmentDto, FileService } from '../../../../../services/file.service';
import { MessagingService } from '../../../../../services/messaging.service';
import { MessageStore } from '../../../../../stores/message.store';
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

  private destroyRef = inject(DestroyRef);

  @ViewChild('editArea') private editAreaRef?: ElementRef<HTMLTextAreaElement>;

  lightbox = signal<{ loading: boolean; att: AttachmentDto | null; name: string } | null>(null);

  @HostListener('document:keydown.escape')
  closeLightbox(): void {
    this.lightbox.set(null);
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

  public content = computed(() => {
    const bytes = Uint8Array.from(atob(this.message().content), c => c.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    return this.emojiDataService.resolveShortcodes(decoded);
  });

  public contentSegments = computed(() => {
    const text = this.content();
    const segments: { type: 'text' | 'mention' | 'gif'; value: string }[] = [];

    // If the entire message is a GIF URL, render it as a single GIF segment
    if (isKlipyGifUrl(text)) {
      return [{ type: 'gif' as const, value: text.trim() }];
    }

    const regex = /@[\w\-.]+#\w+/g;
    let last = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > last) segments.push({ type: 'text', value: text.slice(last, match.index) });
      segments.push({ type: 'mention', value: match[0] });
      last = match.index + match[0].length;
    }
    if (last < text.length) segments.push({ type: 'text', value: text.slice(last) });
    return segments;
  });




  readonly isOwn = computed(() =>
    this.message().authorId === this.profileService.ownProfile()?.userId
  );

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
