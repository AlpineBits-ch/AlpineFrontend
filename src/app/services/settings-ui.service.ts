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

    /**
     * A field within that page to reveal, or null.
     *
     * <p><b>Consumed separately from {@link requestedPage}, and that is not an oversight.</b> The
     * dialog's host clears the page request the instant it acts on it, which is before the page has
     * been created - so a field on that page would never see a value cleared on the same tick. The
     * anchor is therefore left standing for the field itself to claim, via
     * {@link consumeAnchor}.</p>
     *
     * <p>A settings page can be several screens long. Opening the right page and landing at the top
     * of it is, for the person who followed a link about one particular field, close to
     * indistinguishable from having gone nowhere.</p>
     */
    readonly requestedAnchor = signal<string | null>(null);

    /**
     * The same one-way channel, for a guild's settings rather than the account's.
     *
     * <p>A separate request because it is a separate dialog owned by a separate host: the guild
     * dialog is a child of the channel list and is bound to whichever guild that list is drawing, so
     * the guild id travels with the page and the host ignores a request for a guild it is not
     * showing. Without the id, a request raised from a voice channel would open the settings of
     * whichever server the sidebar happened to be on.</p>
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
