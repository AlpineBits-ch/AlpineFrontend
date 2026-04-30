import { Injectable, signal } from '@angular/core';
import { getCurrentWindow, primaryMonitor } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import { LogicalPosition } from '@tauri-apps/api/dpi';
import type { ToastConfig, ToastItem } from './toast.types';

const LEAVE_MS    = 320;
const POPUP_ANIM  = 230; // matches popup leave-animation (220ms) + tiny buffer
const POPUP_W     = 340;
const POPUP_H     = 68;
const MARGIN_RIGHT  = 20;
const MARGIN_BOTTOM = 70; // extra 50px so the Windows taskbar never overlaps
const GAP = 8;

@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<ToastItem[]>([]);

  private isFocused = true;
  private isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  private clickHandlers  = new Map<string, () => void>();
  private popupStack: string[] = [];
  private activePopups   = new Map<string, WebviewWindow>();
  private monitorCache: { sw: number; sh: number } | null = null;
  private soundAt = 0;

  constructor() {
    if (this.isTauri && getCurrentWindow().label === 'main') {
      void this.initMainWindow();
    }
  }

  private async initMainWindow(): Promise<void> {
    const win = getCurrentWindow();
    this.isFocused = await win.isFocused();
    await win.onFocusChanged(ev => { this.isFocused = ev.payload; });

    const bc = new BroadcastChannel('alpine-notifications');
    bc.onmessage = (ev: MessageEvent<{ type: 'ready' | 'clicked' | 'dismissed'; id: string }>) => {
      const { type, id } = ev.data;

      if (type === 'ready') {
        void this.activePopups.get(id)?.show();
        return;
      }

      this.popupStack = this.popupStack.filter(i => i !== id);
      const handler = type === 'clicked' ? this.clickHandlers.get(id) : undefined;
      this.clickHandlers.delete(id);
      void this.repositionStack();

      if (type === 'clicked') {
        handler?.();
      }

      setTimeout(() => {
        void this.activePopups.get(id)?.close();
        this.activePopups.delete(id);
      }, POPUP_ANIM);
    };
  }

  show(config: ToastConfig): string {
    const id = crypto.randomUUID();
    if (config.onClick) this.clickHandlers.set(id, config.onClick);

    if (!this.isTauri || this.isFocused) {
      this.showInApp(id, config);
    } else {
      if (config.sound) this.playSound(config.sound);
      void this.spawnWindow(id, config);
    }

    return id;
  }

  dismiss(id: string): void {
    this.toasts.update(t => t.map(n => n.id === id ? { ...n, leaving: true } : n));
    setTimeout(() => {
      this.toasts.update(t => t.filter(n => n.id !== id));
    }, LEAVE_MS);
  }

  private showInApp(id: string, config: ToastConfig): void {
    this.toasts.update(t => [...t, {
      id,
      title: config.title,
      body: config.body,
      avatarUrl: this.validAvatarUrl(config.avatarUrl),
      avatarLabel: config.avatarLabel,
      duration: config.duration ?? 5000,
      sound: config.sound ?? true,
      onClick: config.onClick,
      leaving: false,
    }]);

    const item = this.toasts().at(-1)!;
    if (item.sound) this.playSound(item.sound);
    if (item.duration > 0) setTimeout(() => this.dismiss(id), item.duration);
  }

  private async spawnWindow(id: string, config: ToastConfig): Promise<void> {
    if (!this.monitorCache) {
      const monitor = await primaryMonitor();
      const sf = monitor?.scaleFactor ?? 1;
      this.monitorCache = {
        sw: (monitor?.size.width ?? 1920) / sf,
        sh: (monitor?.size.height ?? 1080) / sf,
      };
    }

    const { sw, sh } = this.monitorCache;
    const stackIdx = this.popupStack.length;
    const x = Math.round(sw - POPUP_W - MARGIN_RIGHT);
    const y = Math.round(sh - POPUP_H - MARGIN_BOTTOM - stackIdx * (POPUP_H + GAP));

    this.popupStack.push(id);

    const params = new URLSearchParams({ id, title: config.title });
    if (config.body)                          params.set('body', config.body);
    const av = this.validAvatarUrl(config.avatarUrl);
    if (av)                                   params.set('avatarUrl', av);
    if (config.avatarLabel)                   params.set('avatarLabel', config.avatarLabel);
    params.set('duration', String(config.duration ?? 5000));

    const win = new WebviewWindow(`toast-${id}`, {
      url: `toast-popup?${params}`,
      width: POPUP_W,
      height: POPUP_H,
      decorations: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focus: false,
      transparent: true,
      resizable: false,
      visible: false,  // hidden until Angular signals 'ready' via BroadcastChannel
      x,
      y,
    });

    this.activePopups.set(id, win);

    win.once('tauri://destroyed', () => {
      this.popupStack = this.popupStack.filter(i => i !== id);
      this.activePopups.delete(id);
      this.clickHandlers.delete(id);
    });
  }

  private async repositionStack(): Promise<void> {
    if (!this.monitorCache) return;
    const { sw, sh } = this.monitorCache;
    const x = Math.round(sw - POPUP_W - MARGIN_RIGHT);

    for (let i = 0; i < this.popupStack.length; i++) {
      const win = this.activePopups.get(this.popupStack[i]);
      if (!win) continue;
      const y = Math.round(sh - POPUP_H - MARGIN_BOTTOM - i * (POPUP_H + GAP));
      await win.setPosition(new LogicalPosition(x, y));
    }
  }

  private validAvatarUrl(url?: string): string | undefined {
    if (!url) return undefined;
    try {
      const { protocol } = new URL(url);
      return protocol === 'http:' || protocol === 'https:' || protocol === 'data:' ? url : undefined;
    } catch { return undefined; }
  }

  private playSound(sound: boolean | string): void {
    const now = Date.now();
    if (now - this.soundAt < 1000) return;
    this.soundAt = now;

    if (typeof sound === 'string') {
      void new Audio(sound).play();
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
    } catch { /* AudioContext unavailable */ }
  }
}
