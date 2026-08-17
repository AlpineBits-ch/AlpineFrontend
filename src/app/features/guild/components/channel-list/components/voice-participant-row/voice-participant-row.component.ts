import {Component, input, output} from '@angular/core';
import {NgClass} from '@angular/common';
import {TranslateModule} from '@ngx-translate/core';
import {AppAvatarComponent} from '../../../../../../components/avatar/avatar.component';
import {VoiceChannelParticipant} from '../../../../../../services/voice-channel.service';
import {CallLiveBadgeComponent} from '../../../../../../shared/call/call-live-badge/call-live-badge.component';

/** A single member listed underneath a voice channel. */
@Component({
    selector: 'app-voice-participant-row',
    host: {class: 'contents'},
    imports: [NgClass, AppAvatarComponent, TranslateModule, CallLiveBadgeComponent],
    templateUrl: './voice-participant-row.component.html',
})
export class VoiceParticipantRowComponent {
    readonly participant = input.required<VoiceChannelParticipant>();

    /** Row was clicked; the parent decides what that means (join / focus the channel). */
    readonly open = output<void>();
    readonly openMenu = output<MouseEvent>();
    /** The LIVE badge was clicked; focus this participant's stream, do not join anything. */
    readonly watch = output<void>();

    /** Stops the click reaching the row's own handler; a watch click must not also open/join. */
    protected onWatchClick(event: MouseEvent): void {
        event.stopPropagation();
        this.watch.emit();
    }
}
