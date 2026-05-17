import {inject, Injectable, signal} from '@angular/core';
import {RustMediaService, ScreenSource} from './rust-media.service';

export type ScreenPickerResult = string | null; // source ID or null (cancelled)

@Injectable({providedIn: 'root'})
export class ScreenPickerService {
    readonly visible = signal(false);
    readonly sources = signal<ScreenSource[]>([]);
    readonly loading = signal(false);
    private rustMedia = inject(RustMediaService);
    private resolvePickerPromise: ((id: ScreenPickerResult) => void) | null = null;

    /**
     * Open the screen picker overlay and wait for the user to choose a source.
     * Resolves with the selected source ID, or null if cancelled.
     */
    async show(): Promise<ScreenPickerResult> {
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

        return new Promise<ScreenPickerResult>(resolve => {
            this.resolvePickerPromise = resolve;
        });
    }

    select(sourceId: string): void {
        this.visible.set(false);
        this.resolvePickerPromise?.(sourceId);
        this.resolvePickerPromise = null;
    }

    cancel(): void {
        this.visible.set(false);
        this.resolvePickerPromise?.(null);
        this.resolvePickerPromise = null;
    }
}
