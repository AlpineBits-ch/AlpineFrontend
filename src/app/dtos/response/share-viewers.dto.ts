/**
 * The audience of one screen share, as returned by the watch/unwatch endpoints and broadcast as
 * `guild.voice.ShareViewersChanged` / `call.ShareViewersChanged`.
 *
 * <p>Exactly one of `channelId` / `callId` is set, depending on which surface the share lives on.</p>
 */
export interface ShareViewersDto {
    channelId?: string;
    callId?: string;
    shareId: string;
    viewerCount: number;
    viewerIds: string[];
}
