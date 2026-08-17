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
    /** Data URL fallback for the sharer's own tile when the Rust publisher owns the share. */
    previewSrc?: string | null;
    /** Whether this tile's picture is the local publish render, in either representation. */
    localRender?: boolean;
    hasAudio?: boolean;
    isAudioMuted?: boolean;
    renderedFps?: number | null;
    inboundFps?: number | null;
    /** Whether this share's picture is live, or between tracks and expected back. Undefined reads as `'live'`. */
    state?: 'live' | 'resuming';
}

/** One seat on the call stage: a screen share or somebody's camera, in the same grid at the same size. */
export type CallStageTile =
    | {kind: 'share'; id: string; share: CallScreenShare}
    | {kind: 'camera'; id: string; participant: CallParticipant};

/** Tile id for a share. */
export function shareTile(share: CallScreenShare): CallStageTile {
    return {kind: 'share', id: `share:${share.shareId}`, share};
}

/** Tile id for a camera. The kind prefix is required: share ids and user ids overlap, and a duplicate
 *  `@for` track key throws. */
export function cameraTile(participant: CallParticipant): CallStageTile {
    return {kind: 'camera', id: `camera:${participant.userId}`, participant};
}

export interface CallParticipantMenuData {
    x: number;
    y: number;
    participant: CallParticipant;
    volume: number;
    /** The participant's stream volume, separate from `volume` (their voice). Undefined when not sharing. */
    streamVolume?: number;
}

export interface CallScreenLayoutContextMenuEvent {
    event: MouseEvent;
    participant: CallParticipant;
}
