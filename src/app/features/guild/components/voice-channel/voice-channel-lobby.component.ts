import {ChangeDetectionStrategy, Component, computed, input, output} from '@angular/core';
import {ChannelDto} from '../../../../dtos/response/guild.dto';
import {VoiceChannelParticipant} from '../../../../services/voice-channel.service';
import {AppAvatarComponent} from '../../../../components/avatar/avatar.component';
import {CallLiveBadgeComponent} from '../../../../shared/call/call-live-badge/call-live-badge.component';
import {TranslateModule} from '@ngx-translate/core';

@Component({
    selector: 'app-voice-channel-lobby',
    imports: [AppAvatarComponent, CallLiveBadgeComponent, TranslateModule],
    templateUrl: './voice-channel-lobby.component.html',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VoiceChannelLobbyComponent {
    readonly channel = input.required<ChannelDto>();
    readonly participants = input.required<VoiceChannelParticipant[]>();
    readonly joining = input(false);

    joinVoice = output<void>();
    /** Join, then focus this user's stream: the lobby's answer to "I can see someone is live". */
    joinAndWatch = output<string>();

    protected readonly liveStreamer = computed(
        () => this.participants().find(p => p.isScreenSharing) ?? null,
    );
}
