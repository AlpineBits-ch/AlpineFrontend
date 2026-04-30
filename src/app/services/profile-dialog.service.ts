import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class ProfileDialogService {
  readonly selectedUserId = signal<string | null>(null);

  open(userId: string): void {
    this.selectedUserId.set(userId);
  }

  close(): void {
    this.selectedUserId.set(null);
  }
}
