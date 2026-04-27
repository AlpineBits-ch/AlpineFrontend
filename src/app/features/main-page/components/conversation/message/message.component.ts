import {ChangeDetectionStrategy, Component, computed, inject, input} from '@angular/core';
import {MessageDto} from "../../../../../dtos/response/message.dto";
import {Avatar} from "primeng/avatar";
import {AsyncPipe, DatePipe} from "@angular/common";
import {ProfileService} from "../../../../../services/profile.service";
import {Observable} from "rxjs";
import {ProfileDto} from "../../../../../dtos/response/profile.dto";
import {rxResource} from "@angular/core/rxjs-interop";

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

  public message = input.required<MessageDto>();

  public content = computed(() => {
    const bytes = Uint8Array.from(atob(this.message().content), c => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  });

  public contentSegments = computed(() => {
    const text = this.content();
    const segments: { type: 'text' | 'mention'; value: string }[] = [];
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
