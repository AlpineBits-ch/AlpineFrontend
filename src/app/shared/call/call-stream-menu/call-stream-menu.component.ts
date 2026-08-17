import {Component, HostListener, input, output} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';

/**
 * The right-click menu on a screen share tile.
 *
 * <p>Its own component rather than an extension of `CallContextMenuComponent`, which is keyed to
 * `CallParticipantMenuData` and speaks volume sliders, kick, ban and server deafen. A share menu
 * has two items and no participant; sharing the type would mean making every one of those fields
 * optional for a menu that uses none of them.</p>
 *
 * <p>The dismissal is copied from that component deliberately: a document click closes it, the
 * host's own click handler stops propagation so a press on an item never reaches that listener,
 * and Escape closes it too.</p>
 */
@Component({
    selector: 'app-call-stream-menu',
    imports: [TranslateModule],
    templateUrl: './call-stream-menu.component.html',
    host: {'(click)': '$event.stopPropagation()'},
})
export class CallStreamMenuComponent {
    readonly x = input.required<number>();
    readonly y = input.required<number>();

    showStats = output<void>();
    copyStats = output<void>();
    close = output<void>();

    @HostListener('document:click')
    onDocumentClick(): void {
        this.close.emit();
    }

    @HostListener('document:keydown.escape')
    onEscape(): void {
        this.close.emit();
    }
}
