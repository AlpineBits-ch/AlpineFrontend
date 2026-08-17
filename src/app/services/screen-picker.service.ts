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
    /** The source the picker should open on once the list arrives; null when nothing matched, see {@link bestSourceMatch}. */
    readonly preferredSourceId = signal<string | null>(null);
    /** sourceId -> base64 JPEG. An empty string records a source that could not be captured, so it is not re-requested on every scroll. */
    readonly thumbnails = signal<Record<string, string>>({});
    private rustMedia = inject(RustMediaService);
    /** Read for `screenSourcePicker`: a browser cannot enumerate windows, so `getDisplayMedia` opens the host's own picker and this overlay is skipped. */
    private capabilities = inject(PlatformCapabilities);
    private resolvePickerPromise: ((choice: ScreenPickerChoice | null) => void) | null = null;
    /** What the next {@link show} should try to match against, set by {@link preferSourceFor}. */
    private pendingPreference: string | null = null;
    /** Ids already asked for, so scrolling past a tile twice costs one capture. */
    private requested = new Set<string>();
    /** Ids seen since the last flush, batched so a fast scroll is one call rather than twenty. */
    private queued: string[] = [];
    private flushTimer: ReturnType<typeof setTimeout> | null = null;

    /** Ask the next picker to open on whichever window looks like this activity; a hint, consumed by the next open only. */
    preferSourceFor(activityName: string): void {
        this.pendingPreference = activityName;
    }

    /** Record a preset as the one to open the next share at. Store what the user asked for, never a room-clamped version. */
    rememberPreset(preset: StreamPreset): void {
        try {
            localStorage.setItem(PRESET_KEY, JSON.stringify(preset));
        } catch {
            /* storage unavailable */
        }
    }

    /** The preset used for the previous share, so the picker can preselect it. */
    lastPreset(): StreamPreset {
        try {
            const raw = localStorage.getItem(PRESET_KEY);
            return raw
                ? {...DEFAULT_STREAM_PRESET, ...(JSON.parse(raw) as Partial<StreamPreset>)}
                : {...DEFAULT_STREAM_PRESET};
        } catch {
            return {...DEFAULT_STREAM_PRESET};
        }
    }

    /**
     * Open the screen picker overlay and wait for the user to choose a source and quality.
     * Resolves with the choice, or null if cancelled.
     *
     * Where the host owns the picker this resolves immediately and shows nothing, or one share
     * would open two pickers.
     */
    async show(): Promise<ScreenPickerChoice | null> {
        if (!this.capabilities.screenSourcePicker) return this.hostPickedChoice();

        this.visible.set(true);
        this.loading.set(true);
        this.sources.set([]);
        // Thumbnails are a photograph of a moment, and the moment has passed.
        this.thumbnails.set({});
        this.requested.clear();
        this.queued = [];

        // Taken, not read: the hint is good for exactly one open.
        const wanted = this.pendingPreference;
        this.pendingPreference = null;
        this.preferredSourceId.set(null);

        // Load sources in background while overlay is visible
        this.rustMedia
            .getScreenSources()
            .then(list => {
                this.sources.set(list);
                if (wanted) this.preferredSourceId.set(bestSourceMatch(wanted, list));
                this.loading.set(false);
            })
            .catch(() => {
                this.loading.set(false);
            });

        return new Promise<ScreenPickerChoice | null>(resolve => {
            this.resolvePickerPromise = resolve;
        });
    }

    /**
     * The choice to publish with when the host's own picker is the source chooser: empty source id,
     * the remembered preset, and audio requested rather than promised.
     *
     * The dimensions are the primary display's as a stand-in, which is safe only because
     * `solveGeometry` never scales up.
     */
    private hostPickedChoice(): ScreenPickerChoice {
        // Dropped rather than carried: an activity hint needs an enumerated source list.
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

    /** Asks for a source's thumbnail, once. Queued and flushed on a short delay so a fast scroll is one batch. */
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

        // Anything that arrived while that batch was in flight. Sequential on purpose: the Rust
        // side serialises concurrent WGC sessions anyway.
        if (this.queued.length > 0) await this.flushThumbnailQueue();
    }

    select(choice: ScreenPickerChoice): void {
        this.visible.set(false);
        this.rememberPreset(choice.preset);
        this.resolvePickerPromise?.(choice);
        this.resolvePickerPromise = null;
    }

    cancel(): void {
        this.visible.set(false);
        this.resolvePickerPromise?.(null);
        this.resolvePickerPromise = null;
    }
}
