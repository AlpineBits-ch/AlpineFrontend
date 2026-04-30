import { Injectable, signal } from '@angular/core';
import type { ToastConfig, ToastItem } from './toast.types';

const LEAVE_DURATION_MS = 320;

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<ToastItem[]>([]);

  show(config: ToastConfig): string {
    const id = crypto.randomUUID();

    this.toasts.update(t => [...t, {
      id,
      title: config.title,
      body: config.body,
      avatarUrl: config.avatarUrl,
      avatarLabel: config.avatarLabel,
      duration: config.duration ?? 5000,
      sound: config.sound ?? true,
      onClick: config.onClick,
      leaving: false,
    }]);

    const item = this.toasts().at(-1)!;

    if (item.sound) this.playSound(item.sound);
    if (item.duration > 0) setTimeout(() => this.dismiss(id), item.duration);

    return id;
  }

  dismiss(id: string): void {
    this.toasts.update(t => t.map(n => n.id === id ? { ...n, leaving: true } : n));
    setTimeout(() => {
      this.toasts.update(t => t.filter(n => n.id !== id));
    }, LEAVE_DURATION_MS);
  }

  private playSound(sound: boolean | string): void {
    if (typeof sound === 'string') {
      const audio = new Audio(sound);
      void audio.play();
      return;
    }

    try {
      const ctx = new AudioContext();
      const t = ctx.currentTime;

      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.07, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);

      for (const [freq, start, stop] of [
        [880, t, t + 0.18],
        [1108, t + 0.09, t + 0.45],
      ] as const) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        osc.connect(gain);
        osc.start(start);
        osc.stop(stop);
      }
    } catch {
      // AudioContext may be unavailable (e.g. policy restrictions)
    }
  }
}
