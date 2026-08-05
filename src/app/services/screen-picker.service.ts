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
    private rustMedia = inject(RustMediaService);
    private resolvePickerPromise: ((choice: ScreenPickerChoice | null) => void) | null = null;
    /** What the next {@link show} should try to match against, set by {@link preferSourceFor}. */
    private pendingPreference: string | null = null;

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
