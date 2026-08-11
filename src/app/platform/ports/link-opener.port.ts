/**
 * Opens a URL outside the app.
 *
 * <p>On desktop this is the opener plugin, because a navigation inside the webview would replace the
 * app with the page. On web it is a new tab. Either way the current document survives, which is the
 * whole contract.</p>
 */
export abstract class LinkOpener {
    abstract open(url: string): Promise<void>;
}
