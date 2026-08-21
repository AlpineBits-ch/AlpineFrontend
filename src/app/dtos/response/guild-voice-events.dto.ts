import {VoiceEventEnvelope, VoiceResyncEvent} from '../../models/voice-room';

// Guild voice events (server → client).
//
// Every one of these extends VoiceEventEnvelope: the server's announcer stamps `instanceId` and
// `version` onto each payload, so a client holding v7 that receives v9 knows it missed one. See
// VoiceRoomTracker for what to do about it. The fields are optional on the interfaces because the
// guild presence fan-out has not migrated to the announcer yet.

export interface WsUserJoinedVoice extends VoiceEventEnvelope {
    userId: string;
    channelId: string;
    guildId: string;
}

export interface WsUserLeftVoice extends VoiceEventEnvelope {
    userId: string;
    channelId: string;
    guildId: string;
}

export interface WsGuildParticipantJoined extends VoiceEventEnvelope {
    userId: string;
    mediaSessionId: string;
    audioTrackName: string;
    channelId: string;
}

export interface WsGuildTrackPublished extends VoiceEventEnvelope {
    userId: string;
    mediaSessionId: string;
    trackName: string;
    kind: 'video' | 'screen' | 'screenAudio';
    shareId?: string;
    channelId: string;
}

export interface WsGuildTrackClosed extends VoiceEventEnvelope {
    userId: string;
    trackName: string;
    channelId: string;
}

export interface WsVoiceMuteChanged extends VoiceEventEnvelope {
    userId: string;
    isMuted: boolean;
    channelId: string;
    serverForced: boolean;
}

export interface WsVoiceDeafenChanged extends VoiceEventEnvelope {
    userId: string;
    isDeafened: boolean;
    channelId: string;
    serverForced: boolean;
}

export interface WsVoiceCameraChanged extends VoiceEventEnvelope {
    userId: string;
    isCameraOn: boolean;
    channelId: string;
}

export interface WsVoiceScreenShareStarted extends VoiceEventEnvelope {
    userId: string;
    shareId: string;
    trackName: string;
    channelId: string;
}

export interface WsVoiceScreenShareStopped extends VoiceEventEnvelope {
    shareId: string;
    channelId: string;
}

/** {@link VoiceResyncEvent} for a guild channel. */
export interface WsGuildVoiceResync extends VoiceResyncEvent {
    channelId: string;
}

/** We joined this voice channel from another device, so this one was removed from it. */
export interface WsKickedByOtherDevice {
    channelId: string;
    guildId: string;
}

export interface WsMovedToChannel {
    channelId: string;
    guildId: string;
    movedBy: string;
}
