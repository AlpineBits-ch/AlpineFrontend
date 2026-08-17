import {Injectable, signal} from '@angular/core';

@Injectable({providedIn: 'root'})
export class InviteDialogService {
    readonly inviteId = signal<string | null>(null);

    open(inviteId: string): void {
        this.inviteId.set(inviteId);
    }

    close(): void {
        this.inviteId.set(null);
    }
}
