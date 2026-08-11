import type {
    IceServerConfig,
    ScreenPublishOptions,
    ScreenPublishResult,
    ScreenSource,
    SourceThumbnail,
} from '../../services/rust-media.service';

/**
 * The existing screen-share types, unchanged and re-exported.
 *
 * <p>`import type` for the same reason as in `voice-publisher.port.ts`: `rust-media.service.ts`
 * imports `@tauri-apps/api/core` and `@tauri-apps/plugin-os` as values, and only a type-only import
 * keeps those out of the web bundle while still letting a migrated caller depend on this port
 * alone.</p>
 */
export type {IceServerConfig, ScreenPublishOptions, ScreenPublishResult, ScreenSource, SourceThumbnail};

/**
 * Publishing a screen or window.
 *
 * <p>{@link hasSourcePicker} is what the UI branches on. On web `getDisplayMedia` opens the
 * browser's own picker, so the in-app `ScreenPickerComponent` is skipped entirely - but the preset
 * chooser still applies and geometry is still solved through the existing `solveGeometry`, because
 * resolution and bitrate are ours to decide on either host.</p>
 *
 * <p>Screen <b>audio</b> is a request, never a guarantee: it is Chromium-only and tab/window-scoped
 * on web, and needs a usable loopback device on desktop. Both adapters answer with what was actually
 * published in {@link ScreenPublishResult.audioTrackName} - announce that rather than assuming
 * `shareAudio` succeeded, or viewers subscribe to a track that does not exist.</p>
 */
export abstract class ScreenPublisher {
    /**
     * Every shareable screen and window, without thumbnails.
     *
     * <p>Metadata only, and fast: capturing a preview of each is a full-resolution grab per source
     * and used to hold the dialog for tens of seconds on a busy desktop. Empty on web, where the
     * host picker is the enumerator.</p>
     */
    abstract sources(): Promise<ScreenSource[]>;

    /**
     * Thumbnails for the named sources, fetched per tile.
     *
     * <p>An id that could not be captured comes back with an empty thumbnail rather than being
     * dropped, so a caller can tell "failed" from "not asked for yet".</p>
     */
    abstract thumbnails(ids: string[]): Promise<SourceThumbnail[]>;

    abstract start(o: ScreenPublishOptions): Promise<ScreenPublishResult>;

    /**
     * Stop one share.
     *
     * <p>`shareId` is named here although the current Rust commands are singletons that take no id -
     * `stop_screen_publish`, `set_publish_fps` and `set_screen_audio_muted` all address "the share".
     * Carrying the id in the port is what makes these three implementable when more than one share
     * can run; the Tauri adapter validates it against the running share rather than ignoring it, so
     * a stale id fails loudly instead of stopping somebody else's stream.</p>
     */
    abstract stop(shareId: string): Promise<void>;

    /**
     * Change the capture rate mid-stream.
     *
     * <p>Framerate is the only part of a preset that changes without rebuilding the encoder, which is
     * fixed to one geometry and bitrate for its lifetime; a resolution change restarts the publish.</p>
     */
    abstract setFps(shareId: string, fps: number): Promise<void>;

    /** Mute the share's own sound. Stops packets, not the capture device, so unmuting is instant. */
    abstract setAudioMuted(shareId: string, muted: boolean): Promise<void>;

    /** Web: the OS picker chooses the source, so the in-app picker is skipped. */
    abstract readonly hasSourcePicker: boolean;
}
