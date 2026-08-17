import type {
    IceServerConfig,
    PublishSpec,
    ScreenPublishOptions,
    ScreenPublishResult,
    ScreenSource,
    SourceThumbnail,
} from '../../services/rust-media.service';
import type {StreamStatsSnapshot} from '../../shared/call/stream-stats';

/**
 * The existing screen-share types, unchanged and re-exported.
 *
 * Must stay `import type`: a value import would pull the Tauri modules into the web bundle.
 */
export type {
    IceServerConfig,
    PublishSpec,
    ScreenPublishOptions,
    ScreenPublishResult,
    ScreenSource,
    SourceThumbnail,
};
export type {StreamStatsSnapshot};

/**
 * Publishing a screen or window.
 *
 * Screen audio is a request, never a guarantee. Announce what actually published, from
 * {@link ScreenPublishResult.audioTrackName}, or viewers subscribe to a track that does not exist.
 */
export abstract class ScreenPublisher {
    /** Every shareable screen and window, without thumbnails. Empty on web. */
    abstract sources(): Promise<ScreenSource[]>;

    /** Thumbnails for the named sources. An uncapturable id comes back empty rather than dropped. */
    abstract thumbnails(ids: string[]): Promise<SourceThumbnail[]>;

    abstract start(o: ScreenPublishOptions): Promise<ScreenPublishResult>;

    /** Stop one share. A stale `shareId` must fail loudly, never stop the running share. */
    abstract stop(shareId: string): Promise<void>;

    /** Change the capture rate mid-stream. Lands within one frame on either host. */
    abstract setFps(shareId: string, fps: number): Promise<void>;

    /**
     * Retype a running publish (geometry, bitrate, content mode) without ending it. The session,
     * the track and the `shareId` all survive.
     *
     * The fields must stay one object applied in one call: the encoder takes them all at a single
     * frame boundary. Best-effort by contract, so callers must not gate anything on it.
     */
    abstract setSpec(shareId: string, spec: PublishSpec): Promise<void>;

    /** Mute the share's own sound. Stops packets, not the capture device, so unmuting is instant. */
    abstract setAudioMuted(shareId: string, muted: boolean): Promise<void>;

    /**
     * Live statistics for the running publication, or null when `shareId` is not the running share.
     *
     * Counters are cumulative: the caller differentiates successive samples into rates.
     */
    abstract stats(shareId: string): Promise<StreamStatsSnapshot | null>;

    /** Web: the OS picker chooses the source, so the in-app picker is skipped. */
    abstract readonly hasSourcePicker: boolean;
}
