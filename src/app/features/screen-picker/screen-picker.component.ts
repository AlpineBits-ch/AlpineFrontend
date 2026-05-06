import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { ScreenPickerService } from '../../services/screen-picker.service';
import { ScreenSource } from '../../services/rust-media.service';

@Component({
  selector: 'app-screen-picker',
  templateUrl: './screen-picker.component.html',
  styleUrl: './screen-picker.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ScreenPickerComponent {
  readonly picker = inject(ScreenPickerService);

  readonly selectedId = signal<string | null>(null);
  readonly activeTab  = signal<'monitors' | 'windows'>('monitors');

  get monitors(): ScreenSource[] {
    return this.picker.sources().filter(s => s.isMonitor);
  }

  get windows(): ScreenSource[] {
    return this.picker.sources().filter(s => !s.isMonitor);
  }

  select(source: ScreenSource): void {
    this.selectedId.set(source.id);
  }

  confirm(): void {
    const id = this.selectedId();
    if (id) this.picker.select(id);
  }

  cancel(): void {
    this.selectedId.set(null);
    this.picker.cancel();
  }

  thumbSrc(source: ScreenSource): string {
    return source.thumbnail
      ? `data:image/jpeg;base64,${source.thumbnail}`
      : '';
  }
}
