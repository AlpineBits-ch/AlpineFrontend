import { Component, inject, OnInit, OnDestroy } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Window as TauriWindow } from '@tauri-apps/api/window';

@Component({
  selector: 'app-toast-popup',
  templateUrl: './toast-popup.component.html',
  styleUrl: './toast-popup.component.css',
  imports: [],
})
export class ToastPopupComponent implements OnInit, OnDestroy {
  private route = inject(ActivatedRoute);
  private bc!: BroadcastChannel;
  private timer?: ReturnType<typeof setTimeout>;

  protected id = '';
  protected title = '';
  protected body = '';
  protected avatarUrl = '';
  protected avatarLetter = '';
  protected duration = 5000;
  protected leaving = false;
  protected avatarBroken = false;

  ngOnInit(): void {
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';

    this.bc = new BroadcastChannel('alpine-notifications');

    const p = this.route.snapshot.queryParamMap;
    this.id         = p.get('id') ?? '';
    this.title      = p.get('title') ?? '';
    this.body       = p.get('body') ?? '';
    this.avatarUrl  = p.get('avatarUrl') ?? '';
    this.avatarLetter = (p.get('avatarLabel') ?? this.title).charAt(0).toUpperCase();
    this.duration   = Number(p.get('duration') ?? '5000');

    // Signal the main window that content is ready — it will call show() on this window.
    // This prevents the blank-frame flash that occurs before Angular renders.
    this.bc.postMessage({ type: 'ready', id: this.id });

    if (this.duration > 0) {
      this.timer = setTimeout(() => this.dismiss(), this.duration);
    }
  }

  ngOnDestroy(): void {
    clearTimeout(this.timer);
    this.bc.close();
  }

  protected handleClick(): void {
    clearTimeout(this.timer);
    this.leaving = true;
    // Call setFocus from here — popup IS the foreground window, so Windows
    // grants the focus transfer. Main window's BC handler can't do this because
    // it runs on a different thread that doesn't hold foreground rights.
    void new TauriWindow('main').unminimize().then(() =>
      new TauriWindow('main').setFocus()
    ).catch(() => {});
    this.bc.postMessage({ type: 'clicked', id: this.id });
  }

  protected onAvatarError(): void { this.avatarBroken = true; }

  protected handleDismiss(event: MouseEvent): void {
    event.stopPropagation();
    this.dismiss();
  }

  private dismiss(): void {
    clearTimeout(this.timer);
    this.leaving = true;
    this.bc.postMessage({ type: 'dismissed', id: this.id });
  }
}
