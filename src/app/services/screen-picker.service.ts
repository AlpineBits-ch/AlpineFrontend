import {inject, Injectable, signal} from '@angular/core';
import {RustMediaService, ScreenSource} from './rust-media.service';
import {DEFAULT_STREAM_PRESET, StreamPreset} from '../models/stream-preset';

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
    private rustMedia = inject(RustMediaService);
    private resolvePickerPromise: ((choice: ScreenPickerChoice | null) => void) | null = null;

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

        // Load sources in background while overlay is visible
        this.rustMedia.getScreenSources().then(list => {
            this.sources.set(list);
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
