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
     * Data URL fallback for the sharer's own tile when the Rust publisher owns the share.
     *
     * A 480px JPEG at 5 fps, and no longer the usual picture: the local tile normally decodes the
     * publish itself into {@link stream} (see `local-stream-render.ts`). This is what a webview with
     * no `VideoDecoder` gets, and what fills the gap before the first keyframe is decoded.
     */
    previewSrc?: string | null;
    /**
     * Whether this tile's picture is the local publish render - in either representation.
     *
     * <p>The thing the idle preview pause applies to, and why it is a flag rather than a check on
     * `previewSrc`: the same picture arrives as a decoded {@link stream} on a host that can decode
     * and as a thumbnail on one that cannot, and a renderer that claims for only one of them lets
     * the pause fire while the other is on screen at full cost.</p>
     *
     * <p>False for a browser publish, whose local tile holds the `getDisplayMedia` track itself -
     * nothing there is being rendered on this service's behalf, so there is nothing to pause.</p>
     */
    localRender?: boolean;
    hasAudio?: boolean;
    isAudioMuted?: boolean;
    renderedFps?: number | null;
    inboundFps?: number | null;
}

/**
 * One seat on the call stage - a screen share or somebody's camera, laid out in the same grid at the
 * same size.
 *
 * <p><b>Why a union and not two lists.</b> The stage used to switch wholesale: the moment any share
 * existed, shares took the grid and every camera collapsed to a 32px circle in the participants
 * strip. A face-cam beside a game stream was not expressible, which is the one arrangement people
 * actually want. Ordering the two kinds against each other only means anything if they are in one
 * list, and a list of "either" is a union.</p>
 *
 * <p>The tile is a thin wrapper rather than a flattened shape with optional members: the two kinds
 * are rendered by two different components (`app-call-share-tile` and `app-call-participant-tile`)
 * that want the original view models, and flattening would only mean rebuilding them at the
 * template.</p>
 */
export type CallStageTile =
    | {kind: 'share'; id: string; share: CallScreenShare}
    | {kind: 'camera'; id: string; participant: CallParticipant};

/**
 * Tile id for a share - see {@link cameraTile} for why it is prefixed rather than the bare share id.
 */
export function shareTile(share: CallScreenShare): CallStageTile {
    return {kind: 'share', id: `share:${share.shareId}`, share};
}

/**
 * Tile id for a camera.
 *
 * <p>Both ids carry their kind as a prefix because the two id spaces genuinely overlap: guild voice
 * has one share per participant and falls back to the user id when the server has issued no media
 * session id (see `guildScreenShares`), so a person sharing their screen with their camera on
 * produces two tiles under the identical raw id. Without the prefix that is a duplicate `@for` track
 * key, and Angular's answer to a duplicate key is to throw.</p>
 *
 * <p>This is the id the grid tracks by, and deliberately not the one `maximizedId` holds - maximise
 * remains a share-only idea, because only the share tile offers the control. See the doc on
 * `CallScreenLayoutComponent.displayedTiles`.</p>
 */
export function cameraTile(participant: CallParticipant): CallStageTile {
    return {kind: 'camera', id: `camera:${participant.userId}`, participant};
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
