import {Injectable, signal} from '@angular/core';

/**
 * Lets anything open the settings dialog on a chosen page. A one-way channel: a request is a page
 * id, consumed and cleared by whoever owns the dialog.
 */
@Injectable({providedIn: 'root'})
export class SettingsUiService {
    /** Page id to open, or null when there is nothing pending. */
    readonly requestedPage = signal<string | null>(null);

    /**
     * A field within that page to reveal, or null. Must be consumed separately from
     * {@link requestedPage}: the host clears the page request before the page exists, so an anchor
     * cleared on the same tick would never be seen. The field claims it via {@link consumeAnchor}.
     */
    readonly requestedAnchor = signal<string | null>(null);

    /**
     * The same one-way channel, for a guild's settings. The guild id must travel with the page:
     * without it, a request raised from a voice channel opens whichever server the sidebar is on.
     */
    readonly requestedGuildPage = signal<{ guildId: string; page: string } | null>(null);

    open(page: string, anchor?: string): void {
        this.requestedAnchor.set(anchor ?? null);
        this.requestedPage.set(page);
    }

    openGuild(guildId: string, page: string): void {
        this.requestedGuildPage.set({guildId, page});
    }

    /** Called by the guild dialog's host once it has acted on the request. */
    consumeGuild(): void {
        this.requestedGuildPage.set(null);
    }

    /** Called by the dialog's host once it has acted on the request. Leaves the anchor alone. */
    consume(): void {
        this.requestedPage.set(null);
    }

    /** Called by the field named in the anchor, once it has revealed itself. */
    consumeAnchor(): void {
        this.requestedAnchor.set(null);
    }
}
