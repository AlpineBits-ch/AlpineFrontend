import {Component} from '@angular/core';

/** Three animated dots indicating that someone is typing. */
@Component({
    selector: 'app-typing-dots',
    template: `
        <span class="flex gap-0.5 items-end shrink-0">
            <span class="typing-dot"></span>
            <span class="typing-dot"></span>
            <span class="typing-dot"></span>
        </span>
    `,
})
export class TypingDotsComponent {}
