import {Component} from '@angular/core';

/** Horizontal line shown between rows while dragging a channel or category. */
@Component({
    selector: 'app-channel-drop-indicator',
    host: {class: 'contents'},
    template: `
        <div class="mx-1 h-0.5 rounded-full bg-brand my-0.5"></div>
    `,
})
export class ChannelDropIndicatorComponent {
}
