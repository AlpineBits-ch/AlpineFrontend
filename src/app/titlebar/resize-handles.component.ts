import {Component, inject, OnInit, signal} from '@angular/core';
import {ResizeDirection, WindowChrome} from '../platform/ports/window-chrome.port';

// The titlebar (38px) owns the full top edge and its corners, so top/nw/ne handles are omitted.
@Component({
    selector: 'app-resize-handles',
    template: `
        @if (isTauri()) {
            <div class="s" (mousedown)="resize('South')"></div>
            <div class="e" (mousedown)="resize('East')"></div>
            <div class="w" (mousedown)="resize('West')"></div>
            <div class="sw" (mousedown)="resize('SouthWest')"></div>
            <div class="se" (mousedown)="resize('SouthEast')"></div>
        }
    `,
    styles: [
        `
            :host {
                pointer-events: none;
            }
            div {
                position: fixed;
                z-index: 9999;
                pointer-events: all;
            }
            /* Sides start below the 38px titlebar */
            .e {
                right: 0;
                top: 42px;
                bottom: 12px;
                width: 5px;
                cursor: e-resize;
            }
            .w {
                left: 0;
                top: 42px;
                bottom: 12px;
                width: 5px;
                cursor: w-resize;
            }
            /* Bottom edge and corners are free of titlebar */
            .s {
                bottom: 0;
                left: 12px;
                right: 12px;
                height: 5px;
                cursor: s-resize;
            }
            .sw {
                bottom: 0;
                left: 0;
                width: 12px;
                height: 12px;
                cursor: sw-resize;
            }
            .se {
                bottom: 0;
                right: 0;
                width: 12px;
                height: 12px;
                cursor: se-resize;
            }
        `,
    ],
})
export class ResizeHandlesComponent implements OnInit {
    private readonly chrome = inject(WindowChrome);

    /** Whether this host lets the app own its frame, and so has one to resize. */
    protected readonly isTauri = signal(false);

    ngOnInit(): void {
        this.isTauri.set(this.chrome.supported);
    }

    protected async resize(direction: ResizeDirection): Promise<void> {
        await this.chrome.startResizeDragging(direction);
    }
}
