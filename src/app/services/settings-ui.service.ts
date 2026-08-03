import {Injectable, signal} from '@angular/core';

/**
 * Lets anything open the settings dialog on a chosen page.
 *
 * <p>The dialog itself is a child of the quick-settings strip and its visibility is a local
 * signal there, which is fine for the gear button sitting next to it and useless for the
 * titlebar at the other end of the window. This is the one-way channel between them: a request
 * is a page id, consumed and cleared by whoever owns the dialog.</p>
 */
@Injectable({providedIn: 'root'})
export class SettingsUiService {
    /** Page id to open, or null when there is nothing pending. */
    readonly requestedPage = signal<string | null>(null);

    open(page: string): void {
        this.requestedPage.set(page);
    }

    /** Called by the dialog's host once it has acted on the request. */
    consume(): void {
        this.requestedPage.set(null);
    }
}
