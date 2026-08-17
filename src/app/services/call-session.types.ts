export interface CallParticipantUi {
    userId: string;
    displayName: string;
    avatarLabel: string;
    avatarUrl: string | undefined;
    isLocal: boolean;
    isMuted: boolean;
    isSpeaking: boolean;
    isCameraOn: boolean;
    videoStream: MediaStream | undefined; // local = getUserMedia; remote = WebRTC (set via onCameraChanged)
    // WebRTC -add when implementing:
    // audioStream?: MediaStream;
}

export interface ScreenShareUi {
    shareId: string;
    userId: string;
    displayName: string;
    isLocal: boolean;
    stream: MediaStream | undefined; // local = getDisplayMedia; remote = WebRTC (set via onScreenShareStarted)
    /** Whether this share's picture is live or between tracks. Absent reads as live. */
    state?: 'live' | 'resuming';
}

export interface LocalCallState {
    isMuted: boolean;
    isDeafened: boolean;
    isCameraOn: boolean;
    isSharing: boolean;
}

export interface ActiveCallSession {
    callId: string;
    conversationId: string;
    participants: CallParticipantUi[];
    screenShares: ScreenShareUi[];
    local: LocalCallState;
    startedAt: Date;
}
