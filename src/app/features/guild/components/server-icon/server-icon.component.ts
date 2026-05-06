import { Component, effect, input, OnDestroy, signal } from '@angular/core';
import { NgClass } from '@angular/common';

export interface ServerData {
  id: string;
  name: string;
  icon?: string;
  isHome: boolean;
  badge?: number;
  isActive?: boolean;
  hasUnread?: boolean;
}

@Component({
  selector: 'app-server-icon',
  imports: [NgClass],
  templateUrl: './server-icon.component.html',
  styleUrl: './server-icon.component.css',
})
export class ServerIconComponent implements OnDestroy {
  serverData = input.required<ServerData>();

  protected imgSrc = signal('');
  protected imgFailed = signal(false);

  private retryCount = 0;
  private retryTimers: ReturnType<typeof setTimeout>[] = [];

  constructor() {
    effect(() => {
      this.reset(this.serverData().icon ?? '');
    }, { allowSignalWrites: true });
  }

  private reset(url: string): void {
    this.retryTimers.forEach(t => clearTimeout(t));
    this.retryTimers = [];
    this.retryCount = 0;
    this.imgFailed.set(false);
    this.imgSrc.set(url);
  }

  protected onImgError(): void {
    this.imgFailed.set(true);
    const delays = [2000, 4000];
    if (this.retryCount < delays.length) {
      const delay = delays[this.retryCount++];
      const base = this.serverData().icon ?? '';
      const timer = setTimeout(() => {
        const sep = base.includes('?') ? '&' : '?';
        this.imgSrc.set(`${base}${sep}_t=${Date.now()}`);
        this.imgFailed.set(false);
      }, delay);
      this.retryTimers.push(timer);
    }
  }

  ngOnDestroy(): void {
    this.retryTimers.forEach(t => clearTimeout(t));
  }
}
