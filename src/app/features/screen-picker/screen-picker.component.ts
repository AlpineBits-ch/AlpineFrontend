import {
    ChangeDetectionStrategy,
    Component,
    effect,
    ElementRef,
    inject,
    OnDestroy,
    signal,
    viewChild,
} from '@angular/core';
import {FormsModule} from '@angular/forms';
import {ToggleSwitch} from 'primeng/toggleswitch';
import {ScreenPickerService} from '../../services/screen-picker.service';
import {RustMediaService, ScreenSource} from '../../services/rust-media.service';
import {
    FRAMERATE_OPTIONS,
    RESOLUTION_LABELS,
    StreamFramerate,
    StreamResolution,
} from '../../models/stream-preset';
import {solveGeometry} from '../../models/capture-geometry';
import {TranslateModule} from '@ngx-translate/core';
import {NgClass} from '@angular/common';
import {InViewDirective} from '../../directives/in-view.directive';

/** Size of the picker's live preview. Deliberately small - it is a preview, not the stream. */
const PREVIEW_GEOMETRY = {width: 640, height: 360};

@Component({
    selector: 'app-screen-picker',
    imports: [TranslateModule, FormsModule, ToggleSwitch, NgClass, InViewDirective],
    templateUrl: './screen-picker.component.html',
    styleUrl: './screen-picker.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ScreenPickerComponent implements OnDestroy {
    readonly picker = inject(ScreenPickerService);
    readonly activeTab = signal<'monitors' | 'windows'>('monitors');
    readonly previewStream = signal<MediaStream | null>(null);

    /** Two-step flow, mirroring Discord's Go Live: choose a source, then choose quality. */
    readonly step = signal<'source' | 'quality'>('source');
    readonly selectedSource = signal<ScreenSource | null>(null);
    readonly resolution = signal<StreamResolution>('1080p');
    readonly framerate = signal<StreamFramerate>(30);
    readonly shareAudio = signal(true);

    readonly resolutions = Object.entries(RESOLUTION_LABELS)
        .map(([value, label]) => ({value: value as StreamResolution, label}));
    readonly framerates = FRAMERATE_OPTIONS;

    private readonly rustMedia = inject(RustMediaService);
    private readonly livePreviewRef = viewChild<ElementRef<HTMLVideoElement>>('livePreview');

    constructor() {
        const preset = this.picker.lastPreset();
        this.resolution.set(preset.resolution);
        this.framerate.set(preset.framerate);

        // Bind the MediaStream to the video element whenever either changes.
        effect(() => {
            const el = this.livePreviewRef()?.nativeElement;
            const stream = this.previewStream();
            if (!el) return;
            el.srcObject = stream;
            if (stream) el.play().catch(() => {
            });
        });

        // Open on the window the caller asked for, once the list has arrived.
        //
        // This lands the user on the Windows tab with the game already selected and previewing,
        // one click from going live - but it stops there. The picker is the confirmation step, and
        // a match good enough to preselect is still not good enough to publish unasked.
        effect(() => {
            const preferred = this.picker.preferredSourceId();
            const sources = this.picker.sources();
            if (!preferred || this.appliedPreference === preferred) return;

            const source = sources.find(s => s.id === preferred);
            if (!source) return;

            this.appliedPreference = preferred;
            this.activeTab.set('windows');
            this.select(source);
        });
    }

    /**
     * The preference already acted on, so re-running the effect - which every `sources` write does
     * - cannot restart the preview under a user who has since picked something else.
     */
    private appliedPreference: string | null = null;

    get monitors(): ScreenSource[] {
        return this.picker.sources().filter(s => s.isMonitor);
    }

    get windows(): ScreenSource[] {
        return this.picker.sources().filter(s => !s.isMonitor);
    }

    // The per-source aspect ratio that used to size each tile is gone: it made every tile a
    // different height, so the rows never lined up. The tiles are a uniform 16:9 frame now and the
    // image is letterboxed into it, which keeps the source's real shape visible without the grid
    // paying for it.

    /** The size the stream will actually be published at, shown on the quality step. */
    outputLabel(): string {
        const source = this.selectedSource();
        if (!source) return '';
        const {width, height} = solveGeometry(source.width, source.height, this.resolution());
        return `${width} × ${height}`;
    }

    select(source: ScreenSource): void {
        this.selectedSource.set(source);
        this.previewStream.set(null);
        // Start 1 fps capture for a live preview; full quality starts only on Go Live.
        this.rustMedia.startScreenCapture(source.id, PREVIEW_GEOMETRY, 1).then(track => {
            this.previewStream.set(new MediaStream([track]));
        }).catch(() => {
        });
    }

    toQuality(): void {
        if (this.selectedSource()) this.step.set('quality');
    }

    back(): void {
        this.step.set('source');
    }

    goLive(): void {
        const source = this.selectedSource();
        if (!source) return;
        // Don't stop the capture here -startScreenCapture called by the caller
        // will call stopScreenCapture internally before starting at full quality.
        this.previewStream.set(null);
        this.picker.select({
            sourceId: source.id,
            sourceWidth: source.width,
            sourceHeight: source.height,
            preset: {resolution: this.resolution(), framerate: this.framerate()},
            shareAudio: this.shareAudio(),
        });
        this.reset();
    }

    cancel(): void {
        void this.rustMedia.stopScreenCapture();
        this.previewStream.set(null);
        this.picker.cancel();
        this.reset();
    }

    ngOnDestroy(): void {
        void this.rustMedia.stopScreenCapture();
    }

    /**
     * The tile's image, once it has one.
     *
     * <p>Enumeration no longer carries thumbnails - capturing every window up front is what made
     * opening this dialog cost tens of seconds - so this reads the per-source cache the tiles fill
     * as they scroll into view. `source.thumbnail` is still honoured for any caller that supplies
     * one directly.</p>
     */
    thumbSrc(source: ScreenSource): string {
        const captured = this.picker.thumbnails()[source.id] || source.thumbnail;
        return captured ? `data:image/jpeg;base64,${captured}` : '';
    }

    /** Requested, nothing back yet - as opposed to captured-and-failed, which stays as an icon. */
    isThumbnailPending(source: ScreenSource): boolean {
        return !(source.id in this.picker.thumbnails());
    }

    private reset(): void {
        this.selectedSource.set(null);
        this.step.set('source');
        this.appliedPreference = null;
    }
}
