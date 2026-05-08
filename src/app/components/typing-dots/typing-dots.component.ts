import { Component, inject } from '@angular/core';
import { PlatformService } from '../../services/platform.service';

/** Three animated dots indicating that someone is typing. */
@Component({
  selector: 'app-typing-dots',
  template: `
    @if (platformService.isMobile) {
      <span class="flex gap-0.5 items-end shrink-0">
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
      </span>
    } @else {
      <span class="flex gap-0.5 items-end shrink-0">
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
      </span>
    }
  `,
})
export class TypingDotsComponent {
  public platformService = inject(PlatformService);
}
