import {ChangeDetectionStrategy, Component, computed, inject, input} from '@angular/core';
import {MessageDto} from "../../../../../dtos/response/message.dto";
import {Avatar} from "primeng/avatar";
import {AsyncPipe, DatePipe} from "@angular/common";
import {ProfileService} from "../../../../../services/profile.service";
import {Observable} from "rxjs";
import {ProfileDto} from "../../../../../dtos/response/profile.dto";
import {rxResource} from "@angular/core/rxjs-interop";
import { isKlipyGifUrl } from '../../../../../services/gif.service';
import { EmojiDataService } from '../../../../../services/emoji-data.service';

@Component({
  selector: 'app-message',
  imports: [
    Avatar,
    DatePipe,
    AsyncPipe
  ],
  templateUrl: './message.component.html',
  styleUrl: './message.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MessageComponent {
  public profileService = inject(ProfileService);
  private emojiDataService = inject(EmojiDataService);

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
