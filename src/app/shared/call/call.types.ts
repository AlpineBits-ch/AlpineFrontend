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
}

export interface CallScreenLayoutContextMenuEvent {
  event: MouseEvent;
  participant: CallParticipant;
}
