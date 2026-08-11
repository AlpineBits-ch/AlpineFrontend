import {inject, Injectable, signal} from '@angular/core';
import {RustMediaService, ScreenSource} from './rust-media.service';
import {DEFAULT_STREAM_PRESET, StreamPreset} from '../models/stream-preset';
import {bestSourceMatch} from '../models/source-match';
import {PlatformCapabilities} from '../platform/capabilities';

export interface ScreenPickerChoice {
    sourceId: string;
    /**
     * Dimensions of the chosen source. Capture geometry is solved from these before capture starts
     * and then held fixed, so they have to travel with the choice.
     */
    sourceWidth: number;
    sourceHeight: number;
    preset: StreamPreset;
    /** Whether to capture system audio alongside the video. */
    shareAudio: boolean;
}

const PRESET_KEY = 'alpine_stream_preset';

/** How long to gather tiles before asking for their images. One frame of scrolling. */
const THUMBNAIL_BATCH_DELAY_MS = 120;

/** Sources per capture call. Matches the cap the Rust side enforces. */
const THUMBNAIL_BATCH_SIZE = 4;

@Injectable({providedIn: 'root'})
export class ScreenPickerService {
    readonly visible = signal(false);
    readonly sources = signal<ScreenSource[]>([]);
    readonly loading = signal(false);
    /**
     * The source the picker should open on, once the list has arrived. Null when nothing was asked
     * for or when nothing matched well enough — see {@link bestSourceMatch}.
     */
    readonly preferredSourceId = signal<string | null>(null);
    /**
     * sourceId -> base64 JPEG, filled in as tiles come into view. An entry with an empty string is
     * a source that was asked for and could not be captured, which is why it is recorded at all:
     * without it, a minimised window would be re-requested on every scroll.
     */
    readonly thumbnails = signal<Record<string, string>>({});
    private rustMedia = inject(RustMediaService);
    /**
     * Read for `screenSourcePicker`, rather than asking which host this is.
     *
     * <p>The question is "is there an in-app source list to show", and the answer is a capability: a
     * browser cannot enumerate windows, so `getDisplayMedia` opens the host's own picker instead and
     * this overlay is skipped entirely. See {@link show}.</p>
     */
    private capabilities = inject(PlatformCapabilities);
    private resolvePickerPromise: ((choice: ScreenPickerChoice | null) => void) | null = null;
    /** What the next {@link show} should try to match against, set by {@link preferSourceFor}. */
    private pendingPreference: string | null = null;
    /** Ids already asked for, so scrolling past a tile twice costs one capture. */
    private requested = new Set<string>();
    /** Ids seen since the last flush, batched so a fast scroll is one call rather than twenty. */
    private queued: string[] = [];
    private flushTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Ask the next picker to open on whichever window looks like this activity.
     *
     * <p>A hint, not a decision: {@link show} still waits for the user either way. Consumed by the
     * next open and not remembered past it, so a preference set for a game that has since closed
     * cannot preselect a window in some later, unrelated share.</p>
     */
    preferSourceFor(activityName: string): void {
        this.pendingPreference = activityName;
    }

    /** The preset used for the previous share, so the picker can preselect it. */
    lastPreset(): StreamPreset {
        try {
            const raw = localStorage.getItem(PRESET_KEY);
            return raw
                ? {...DEFAULT_STREAM_PRESET, ...JSON.parse(raw) as Partial<StreamPreset>}
                : {...DEFAULT_STREAM_PRESET};
        } catch {
            return {...DEFAULT_STREAM_PRESET};
        }
    }

    /**
     * Open the screen picker overlay and wait for the user to choose a source and quality.
     * Resolves with the choice, or null if cancelled.
     *
     * <p><b>Where the host owns the picker this resolves immediately and shows nothing.</b> There is no
     * source list to offer and no cancel to wait for: `getDisplayMedia` opens the host's own picker
     * later, inside the publish, and a user who cancels *that* fails the publish - which the caller
     * already treats as "no share". Showing this overlay first would be two pickers for one share.</p>
     */
    async show(): Promise<ScreenPickerChoice | null> {
        if (!this.capabilities.screenSourcePicker) return this.hostPickedChoice();

        this.visible.set(true);
        this.loading.set(true);
        this.sources.set([]);
        // Thumbnails are a photograph of a moment, and the moment has passed - a window that was
        // showing a video when the picker last opened is not showing that frame now.
        this.thumbnails.set({});
        this.requested.clear();
        this.queued = [];

        // Taken, not read: the hint is good for exactly one open. Clearing it here also means a
        // picker opened from anywhere else never inherits a preference set by the activity card.
        const wanted = this.pendingPreference;
        this.pendingPreference = null;
        this.preferredSourceId.set(null);

        // Load sources in background while overlay is visible
        this.rustMedia.getScreenSources().then(list => {
            this.sources.set(list);
            if (wanted) this.preferredSourceId.set(bestSourceMatch(wanted, list));
            this.loading.set(false);
        }).catch(() => {
            this.loading.set(false);
        });

        return new Promise<ScreenPickerChoice | null>(resolve => {
            this.resolvePickerPromise = resolve;
        });
    }

    /**
     * The choice to publish with when the host's own picker is the source chooser.
     *
     * <p>Everything here is what a preset needs and nothing more:</p>
     * <ul>
     *   <li><b>No source id.</b> Empty rather than a fabricated "screen" - the publisher ignores it,
     *       and inventing one would imply a source that could be honoured.</li>
     *   <li><b>The preset still applies.</b> It comes from {@link lastPreset} and is solved through
     *       `solveGeometry` exactly as a desktop choice is, so "1080p at 30" means the same thing on
     *       both hosts. Only the in-app picker persists a preset, so until a quality-only chooser
     *       exists for this host a web share opens at the default and is changed with the in-call
     *       quality control, which already works on this path.</li>
     *   <li><b>Audio is requested, not promised.</b> The host picker carries its own "share audio"
     *       checkbox, so asking for it is what puts that choice in front of the user; the publisher
     *       answers with what it actually got, and the share proceeds video-only when that is
     *       nothing. See `RustMediaService.screenAudioOutcome`.</li>
     * </ul>
     *
     * <p>The source dimensions are the primary display's, as the box a preset is solved against. It is
     * a stand-in - the real source is not known until the host picker closes - and a safe one, because
     * `solveGeometry` only ever scales down: a window smaller than the display simply is not capped.</p>
     */
    private hostPickedChoice(): ScreenPickerChoice {
        // Dropped rather than carried: an activity hint can only be honoured against an enumerated
        // source list, and leaving it set would apply it to some later share on a host that can.
        this.pendingPreference = null;

        const scale = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
        const screenSize = typeof window !== 'undefined' ? window.screen : undefined;
        return {
            sourceId: '',
            sourceWidth: Math.round((screenSize?.width ?? 1920) * scale),
            sourceHeight: Math.round((screenSize?.height ?? 1080) * scale),
            preset: this.lastPreset(),
            shareAudio: true,
        };
    }

    /**
     * Asks for a source's thumbnail, once.
     *
     * <p>Called when a tile scrolls into view. Requests are queued and flushed together on a short
     * delay: dragging the scrollbar past thirty windows should cost one batch of whatever ended up
     * on screen, not thirty captures of things already gone again.</p>
     */
    requestThumbnail(sourceId: string): void {
        if (this.requested.has(sourceId)) return;
        this.requested.add(sourceId);
        this.queued.push(sourceId);

        if (this.flushTimer !== null) return;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = null;
            void this.flushThumbnailQueue();
        }, THUMBNAIL_BATCH_DELAY_MS);
    }

    private async flushThumbnailQueue(): Promise<void> {
        const batch = this.queued.splice(0, THUMBNAIL_BATCH_SIZE);
        if (batch.length === 0) return;

        const results = await this.rustMedia.captureSourceThumbnails(batch);
        if (results.length > 0) {
            this.thumbnails.update(current => {
                const next = {...current};
                for (const result of results) next[result.id] = result.thumbnail;
                return next;
            });
        }

        // Anything that arrived while that batch was in flight. Sequential on purpose - two batches
        // at once would put two WGC sessions in flight and the Rust side serialises them anyway.
        if (this.queued.length > 0) await this.flushThumbnailQueue();
    }

    select(choice: ScreenPickerChoice): void {
        this.visible.set(false);
        try {
            localStorage.setItem(PRESET_KEY, JSON.stringify(choice.preset));
        } catch { /* storage unavailable */
        }
        this.resolvePickerPromise?.(choice);
        this.resolvePickerPromise = null;
    }

    cancel(): void {
        this.visible.set(false);
        this.resolvePickerPromise?.(null);
        this.resolvePickerPromise = null;
    }
}
