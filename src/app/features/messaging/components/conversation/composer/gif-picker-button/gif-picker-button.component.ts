import {
  Component,
  ElementRef,
  inject,
  OnDestroy,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Button } from 'primeng/button';
import { GifResult, GifService } from '../../../../../../services/gif.service';
import { Subscription } from 'rxjs';
import { debounceTime, distinctUntilChanged, switchMap } from 'rxjs/operators';
import { Subject } from 'rxjs';

@Component({
  selector: 'app-gif-picker-button',
  imports: [Button, FormsModule],
  templateUrl: './gif-picker-button.component.html',
  styleUrl: './gif-picker-button.component.css',
})
export class GifPickerButtonComponent implements OnDestroy {
  gifSelected = output<string>();

  private searchInputRef = viewChild<ElementRef<HTMLInputElement>>('searchInput');

  showPicker = signal(false);
  searchQuery = signal('');
  gifs = signal<GifResult[]>([]);
  loading = signal(false);

  private gifService = inject(GifService);
  private searchSubject = new Subject<string>();
  private sub: Subscription;
  private outsideClickListener: ((e: MouseEvent) => void) | null = null;

  constructor() {
    this.sub = this.searchSubject.pipe(
      debounceTime(350),
      distinctUntilChanged(),
      switchMap(q => {
        this.loading.set(true);
        return q.trim() ? this.gifService.search(q) : this.gifService.trending();
      }),
    ).subscribe(results => {
      this.gifs.set(results);
      this.loading.set(false);
    });
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
    this.removeOutsideListener();
  }

  toggle(): void {
    if (this.showPicker()) {
      this.close();
    } else {
      this.open();
    }
  }

  openWithSearch(query: string): void {
    this.showPicker.set(true);
    this.loading.set(true);
    this.searchQuery.set(query);
    this.searchSubject.next(query);

    setTimeout(() => {
      this.searchInputRef()?.nativeElement.focus();
      this.outsideClickListener = (e: MouseEvent) => {
        const panel = document.querySelector('.gif-picker-panel');
        const btn = document.querySelector('.gif-picker-btn');
        if (panel && !panel.contains(e.target as Node) && btn && !btn.contains(e.target as Node)) {
          this.close();
        }
      };
      document.addEventListener('mousedown', this.outsideClickListener);
    }, 0);
  }

  open(): void {
    this.showPicker.set(true);
    this.loading.set(true);
    this.gifService.trending().subscribe(results => {
      this.gifs.set(results);
      this.loading.set(false);
    });

    setTimeout(() => {
      this.searchInputRef()?.nativeElement.focus();
      this.outsideClickListener = (e: MouseEvent) => {
        const panel = document.querySelector('.gif-picker-panel');
        const btn = document.querySelector('.gif-picker-btn');
        if (panel && !panel.contains(e.target as Node) && btn && !btn.contains(e.target as Node)) {
          this.close();
        }
      };
      document.addEventListener('mousedown', this.outsideClickListener);
    }, 0);
  }

  close(): void {
    this.showPicker.set(false);
    this.searchQuery.set('');
    this.removeOutsideListener();
  }

  onSearch(query: string): void {
    this.searchQuery.set(query);
    this.searchSubject.next(query);
  }

  select(gif: GifResult): void {
    this.gifSelected.emit(gif.url);
    this.close();
  }

  private removeOutsideListener(): void {
    if (this.outsideClickListener) {
      document.removeEventListener('mousedown', this.outsideClickListener);
      this.outsideClickListener = null;
    }
  }
}
