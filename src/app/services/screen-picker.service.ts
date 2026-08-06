import {inject, Injectable, signal} from '@angular/core';
import {RustMediaService, ScreenSource} from './rust-media.service';
import {DEFAULT_STREAM_PRESET, StreamPreset} from '../models/stream-preset';
import {bestSourceMatch} from '../models/source-match';

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
     */
    async show(): Promise<ScreenPickerChoice | null> {
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
