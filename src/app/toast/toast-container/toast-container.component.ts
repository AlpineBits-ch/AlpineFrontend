import { Component, inject, signal } from '@angular/core';
import { ToastService } from '../toast.service';
import type { ToastItem } from '../toast.types';

@Component({
  selector: 'app-toast-container',
  templateUrl: './toast-container.component.html',
  styleUrl: './toast-container.component.css',
})
export class ToastContainerComponent {
  protected toast = inject(ToastService);
  protected brokenAvatars = signal(new Set<string>());

  protected handleClick(item: ToastItem): void {
    item.onClick?.();
    this.toast.dismiss(item.id);
  }

  protected closeClick(id: string, event: MouseEvent): void {
    event.stopPropagation();
    this.toast.dismiss(id);
  }

  protected avatarLetter(item: ToastItem): string {
    return (item.avatarLabel ?? item.title).charAt(0).toUpperCase();
  }

  protected onAvatarError(id: string): void {
    this.brokenAvatars.update(s => new Set(s).add(id));
  }
}
