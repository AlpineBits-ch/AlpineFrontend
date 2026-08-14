export interface CallParticipant {
    userId: string;
    displayName: string;
    avatarLabel: string;
    avatarUrl?: string;
    isLocal: boolean;
    isMuted: boolean;
    isSpeaking: boolean;
    isCameraOn: boolean;
    videoStream?: MediaStream | null;
    isScreenSharing?: boolean;
    isServerDeafened?: boolean;
}

export interface CallScreenShare {
    shareId: string;
    userId: string;
    displayName: string;
    avatarLabel?: string;
    isLocal: boolean;
    stream?: MediaStream;
    /**
     * Data URL for the sharer's own tile when the Rust publisher owns the share.
     *
     * That path puts no MediaStream in the webview, so there is nothing to bind a `<video>` to;
     * this is a low-rate thumbnail standing in for it.
     */
    previewSrc?: string | null;
    hasAudio?: boolean;
    isAudioMuted?: boolean;
    renderedFps?: number | null;
    inboundFps?: number | null;
}

export interface CallParticipantMenuData {
    x: number;
    y: number;
    participant: CallParticipant;
    volume: number;
    /**
     * The participant's *stream* volume, separate from `volume` (their voice). Undefined when they
     * are not currently sharing - there is nothing to attach a stream slider to - which is also what
     * the template reads to decide whether to render the second slider at all.
     */
    streamVolume?: number;
}

export interface CallScreenLayoutContextMenuEvent {
    event: MouseEvent;
    participant: CallParticipant;
}
