import {ChangeDetectionStrategy, Component, computed, HostListener, inject, input, signal} from '@angular/core';
import {MessageAttachment, MessageDto} from "../../../../../dtos/response/message.dto";
import {Avatar} from "primeng/avatar";
import {AsyncPipe, DatePipe} from "@angular/common";
import {ProfileService} from "../../../../../services/profile.service";
import {Observable} from "rxjs";
import {ProfileDto} from "../../../../../dtos/response/profile.dto";
import { isKlipyGifUrl } from '../../../../../services/gif.service';
import { EmojiDataService } from '../../../../../services/emoji-data.service';
import { MarkdownPipe } from '../../../../../pipes/markdown.pipe';
import { AttachmentDto, FileService } from '../../../../../services/file.service';

@Component({
  selector: 'app-message',
  imports: [
    Avatar,
    DatePipe,
    AsyncPipe,
    MarkdownPipe,
  ],
  templateUrl: './message.component.html',
  styleUrl: './message.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MessageComponent {
  public profileService = inject(ProfileService);
  private emojiDataService = inject(EmojiDataService);
  private fileService = inject(FileService);

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




  public getProfile(): Observable<ProfileDto>{
    return this.profileService.getByUserId(this.message().authorId);
  }
}
