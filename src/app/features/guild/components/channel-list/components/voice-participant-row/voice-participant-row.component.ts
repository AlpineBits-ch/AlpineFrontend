import {Component, input, output} from '@angular/core';
import {NgClass} from '@angular/common';
import {AppAvatarComponent} from '../../../../../../components/avatar/avatar.component';
import {VoiceChannelParticipant} from '../../../../../../services/voice-channel.service';

/** A single member listed underneath a voice channel. */
@Component({
    selector: 'app-voice-participant-row',
    host: {class: 'contents'},
    imports: [NgClass, AppAvatarComponent],
    templateUrl: './voice-participant-row.component.html',
})
export class VoiceParticipantRowComponent {
    participant = input.required<VoiceChannelParticipant>();

    /** Row was clicked — the parent decides what that means (join / focus the channel). */
    readonly open = output<void>();
    readonly openMenu = output<MouseEvent>();
}
