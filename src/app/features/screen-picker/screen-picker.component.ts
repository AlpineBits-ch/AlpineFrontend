import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ScreenPickerService } from '../../services/screen-picker.service';
import { RustMediaService, ScreenSource } from '../../services/rust-media.service';
import { TranslateModule } from '@ngx-translate/core';

@Component({
  selector: 'app-screen-picker',
  imports: [TranslateModule],
  templateUrl: './screen-picker.component.html',
  styleUrl: './screen-picker.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ScreenPickerComponent implements OnDestroy {
  readonly picker     = inject(ScreenPickerService);
  private readonly rustMedia = inject(RustMediaService);

  readonly selectedId   = signal<string | null>(null);
  readonly activeTab    = signal<'monitors' | 'windows'>('monitors');
  readonly previewStream = signal<MediaStream | null>(null);

  private readonly livePreviewRef = viewChild<ElementRef<HTMLVideoElement>>('livePreview');

  constructor() {
    // Bind the MediaStream to the video element whenever either changes.
    effect(() => {
      const el = this.livePreviewRef()?.nativeElement;
      const stream = this.previewStream();
      if (!el) return;
      el.srcObject = stream;
      if (stream) el.play().catch(() => {});
    });
  }

  get monitors(): ScreenSource[] {
    return this.picker.sources().filter(s => s.isMonitor);
  }

  get windows(): ScreenSource[] {
    return this.picker.sources().filter(s => !s.isMonitor);
  }

  select(source: ScreenSource): void {
    this.selectedId.set(source.id);
    this.previewStream.set(null);
    // Start 1 fps capture for a live preview; full fps starts only on confirm.
    this.rustMedia.startScreenCapture(source.id, 1).then(track => {
      this.previewStream.set(new MediaStream([track]));
    }).catch(() => {});
  }

  confirm(): void {
    const id = this.selectedId();
    if (!id) return;
    // Don't stop the capture here — startScreenCapture called by the caller
    // will call stopScreenCapture internally before starting at full fps.
    this.previewStream.set(null);
    this.picker.select(id);
  }

  cancel(): void {
    void this.rustMedia.stopScreenCapture();
    this.previewStream.set(null);
    this.selectedId.set(null);
    this.picker.cancel();
  }

  ngOnDestroy(): void {
    void this.rustMedia.stopScreenCapture();
  }

  thumbSrc(source: ScreenSource): string {
    return source.thumbnail ? `data:image/jpeg;base64,${source.thumbnail}` : '';
  }
}
