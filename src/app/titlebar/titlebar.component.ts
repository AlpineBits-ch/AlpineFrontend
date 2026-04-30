import { Component, OnInit, OnDestroy, signal } from '@angular/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import type { UnlistenFn } from '@tauri-apps/api/event';

@Component({
  selector: 'app-titlebar',
  templateUrl: './titlebar.component.html',
  styleUrl: './titlebar.component.css',
})
export class TitlebarComponent implements OnInit, OnDestroy {
  protected isTauri = signal(false);
  protected isMac = signal(false);
  protected isMaximized = signal(false);
  protected macHover = false;

  private unlisten?: UnlistenFn;

  async ngOnInit(): Promise<void> {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;

    const ua = navigator.userAgent.toLowerCase();
    if (/android|iphone|ipad|ipod/.test(ua)) return;

    this.isTauri.set(true);
    this.isMac.set(ua.includes('mac os') || ua.includes('macos'));

    const win = getCurrentWindow();
    this.isMaximized.set(await win.isMaximized());
    this.unlisten = await win.onResized(async () => {
      this.isMaximized.set(await win.isMaximized());
    });
  }

  ngOnDestroy(): void {
    this.unlisten?.();
  }

  protected minimize(): void { void getCurrentWindow().minimize(); }
  protected toggleMaximize(): void { void getCurrentWindow().toggleMaximize(); }
  protected close(): void { void getCurrentWindow().close(); }
}
