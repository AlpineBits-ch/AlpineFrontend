import {Injectable, signal} from '@angular/core';

@Injectable({providedIn: 'root'})
export class PasswordResetDialogService {
    readonly visible = signal(false);
    /** Pre-filled from whatever the user already typed into the login username field. */
    readonly prefillEmail = signal('');

    show(prefill = ''): void {
        this.prefillEmail.set(prefill);
        this.visible.set(true);
    }

    dismiss(): void {
        this.visible.set(false);
    }
}
