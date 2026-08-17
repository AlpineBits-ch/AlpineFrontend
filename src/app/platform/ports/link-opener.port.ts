/**
 * Opens a URL outside the app: the opener plugin on desktop, a new tab on web.
 *
 * The current document must survive either way.
 */
export abstract class LinkOpener {
    abstract open(url: string): Promise<void>;
}
