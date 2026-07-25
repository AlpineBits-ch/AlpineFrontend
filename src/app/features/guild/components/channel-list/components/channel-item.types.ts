import {ChannelDto} from '../../../../../dtos/response/guild.dto';
import {VoiceChannelParticipant} from '../../../../../services/voice-channel.service';

/** Emitted when a channel row is right-clicked. */
export interface ChannelMenuRequest {
    event: MouseEvent;
    channel: ChannelDto;
}

/** Emitted when a voice participant row is right-clicked. */
export interface ParticipantMenuRequest {
    event: MouseEvent;
    participant: VoiceChannelParticipant;
    channelId: string;
}
