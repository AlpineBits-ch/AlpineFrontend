import {Component, computed, input, output} from '@angular/core';
import {ChannelDto} from '../../../../dtos/response/guild.dto';
import {VoiceChannelParticipant} from '../../../../services/voice-channel.service';
import {AppAvatarComponent} from '../../../../components/avatar/avatar.component';
import {CallLiveBadgeComponent} from '../../../../shared/call/call-live-badge/call-live-badge.component';
import {TranslateModule} from '@ngx-translate/core';

@Component({
    selector: 'app-voice-channel-lobby',
    imports: [AppAvatarComponent, CallLiveBadgeComponent, TranslateModule],
    templateUrl: './voice-channel-lobby.component.html',
})
export class VoiceChannelLobbyComponent {
    channel = input.required<ChannelDto>();
    participants = input.required<VoiceChannelParticipant[]>();

    joinVoice = output<void>();
    /** Join, then focus this user's stream - the lobby's answer to "I can see someone is live". */
    joinAndWatch = output<string>();

    /**
     * Whoever is live right now, so the lobby can offer a second join action naming them. Only the
     * first is used - one extra button is enough to say "someone is live"; the participant tiles
     * beneath the header already show a badge per streamer once you look closer.
     */
    protected readonly liveStreamer = computed(() => this.participants().find(p => p.isScreenSharing) ?? null);
}
