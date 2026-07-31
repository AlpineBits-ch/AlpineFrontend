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

/** Size of the picker's live preview. Deliberately small - it is a preview, not the stream. */
const PREVIEW_GEOMETRY = {width: 640, height: 360};

@Component({
    selector: 'app-screen-picker',
    imports: [TranslateModule, FormsModule, ToggleSwitch],
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
    }

    get monitors(): ScreenSource[] {
        return this.picker.sources().filter(s => s.isMonitor);
    }

    get windows(): ScreenSource[] {
        return this.picker.sources().filter(s => !s.isMonitor);
    }

    /** The source's own aspect ratio, so the thumbnail shows what will actually be shared. */
    aspect(source: ScreenSource): string {
        return source.width > 0 && source.height > 0 ? `${source.width}/${source.height}` : '16/9';
    }

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

    thumbSrc(source: ScreenSource): string {
        return source.thumbnail ? `data:image/jpeg;base64,${source.thumbnail}` : '';
    }

    private reset(): void {
        this.selectedSource.set(null);
        this.step.set('source');
    }
}
