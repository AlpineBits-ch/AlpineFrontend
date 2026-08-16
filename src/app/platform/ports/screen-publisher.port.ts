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
 * <p>`import type` for the same reason as in `voice-publisher.port.ts`: `rust-media.service.ts`
 * imports `@tauri-apps/api/core` and `@tauri-apps/plugin-os` as values, and only a type-only import
 * keeps those out of the web bundle while still letting a migrated caller depend on this port
 * alone.</p>
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

    /** Change the capture rate mid-stream. Lands within one frame on either host. */
    abstract setFps(shareId: string, fps: number): Promise<void>;

    /**
     * Retype a running publish - output geometry, bitrate and content mode - without ending it.
     *
     * <p><b>Nothing a viewer can see changes identity.</b> The session, the track and therefore the
     * `shareId` all survive this, so a resolution change is not announced to anybody - viewers get a
     * picture that changes size, which is what any encoder adapting on its own already produces.</p>
     *
     * <p>This used to be a stop followed by a start on the desktop host, because its encoder is
     * built for one geometry. That cost a new share id, and every viewer's tile left the grid for
     * one to four seconds - long enough that a maximised stream emptied the stage completely. The
     * encoder is retyped in place instead; the web host has always done the equivalent.</p>
     *
     * <p><b>One object rather than four arguments</b>, and one call rather than one per field:
     * these move together by rule. The encoder is built from all of them at once and applies them
     * at a single frame boundary, so splitting them would let a share run with the geometry from one
     * preset and the mode from another for as long as the second call took.</p>
     *
     * <p>Best-effort by contract. A host that declines - a driver refusing a retype - leaves the
     * share running as it already was, which is a picture the viewer can still watch. Callers must
     * not treat this as a gate on anything.</p>
     */
    abstract setSpec(shareId: string, spec: PublishSpec): Promise<void>;

    /** Mute the share's own sound. Stops packets, not the capture device, so unmuting is instant. */
    abstract setAudioMuted(shareId: string, muted: boolean): Promise<void>;

    /**
     * Live statistics for the running publication, or null when `shareId` is not the running share.
     *
     * <p>Null rather than a throw for a stale id, unlike {@link stop}: a stats poll racing a share
     * that just ended is routine, and the caller's answer to "no data" is already to say so.</p>
     *
     * <p><b>Counters are cumulative.</b> Byte and packet totals come back as the transport reports
     * them and the caller differentiates successive samples into rates - see `kbpsBetween`. That
     * keeps the desktop command stateless and puts the rate arithmetic in the one place that is
     * unit-tested.</p>
     */
    abstract stats(shareId: string): Promise<StreamStatsSnapshot | null>;

    /** Web: the OS picker chooses the source, so the in-app picker is skipped. */
    abstract readonly hasSourcePicker: boolean;
}
