import {Component, HostListener, input, output} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {CallParticipantMenuData} from '../call.types';

@Component({
    selector: 'app-call-context-menu',
    imports: [TranslateModule],
    templateUrl: './call-context-menu.component.html',
    styleUrl: './call-context-menu.component.css',
    host: {'(click)': '$event.stopPropagation()'}
})
export class CallContextMenuComponent {
    menu = input.required<CallParticipantMenuData>();
    isSuperadmin = input<boolean>(false);
    /**
     * Whether the guild has its Moderation module on. Kick and ban answer to it, server
     * deafen doesn't - and a DM call has no guild at all, hence the permissive default.
     */
    moderationEnabled = input<boolean>(true);

    close = output<void>();
    volumeChange = output<number>();
    streamVolumeChange = output<number>();
    kick = output<void>();
    ban = output<void>();
    serverDeafen = output<void>();

    @HostListener('document:click')
    onDocumentClick(): void {
        this.close.emit();
    }

    @HostListener('document:keydown.escape')
    onEscape(): void {
        this.close.emit();
    }

    onVolumeInput(event: Event): void {
        this.volumeChange.emit(parseInt((event.target as HTMLInputElement).value, 10));
    }

    onStreamVolumeInput(event: Event): void {
        this.streamVolumeChange.emit(parseInt((event.target as HTMLInputElement).value, 10));
    }
}
