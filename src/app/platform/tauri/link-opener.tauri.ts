import {LinkOpener} from '../ports/link-opener.port';

/**
 * Hands the URL to the OS, which gives it to the user's default browser.
 *
 * <p>Not a navigation: inside a webview, following a link would replace the running application
 * with the page. That is the whole reason the opener plugin exists on this host.</p>
 */
export class TauriLinkOpener extends LinkOpener {
    override async open(url: string): Promise<void> {
        const {openUrl} = await import('@tauri-apps/plugin-opener');
        await openUrl(url);
    }
}
