import {inject, Injectable} from '@angular/core';
import {LinkOpener} from '../platform/ports/link-opener.port';

/**
 * Opens a link outside the app.
 *
 * <p>A thin delegate over {@link LinkOpener} - the shell decides how "outside" is reached (the OS
 * default browser on desktop, a new tab on web) and this keeps the shape every caller already uses.</p>
 */
@Injectable({
  providedIn: 'root',
})
export class ExternalLinkService {
   private readonly links = inject(LinkOpener);

   /**
    * Opens `url`, swallowing whatever went wrong.
    *
    * <p>The swallow is deliberate and predates the port: almost every caller invokes this as
    * `void openExternalLink(...)` from a click handler, so a rejection would surface as an unhandled
    * promise rejection - and in production, as a Sentry report - for a link that failed to open, which
    * is nothing the user can act on and nothing the app can retry.</p>
    *
    * <p>The success path is deliberately silent. A url is not diagnostic on its own and it carries
    * whatever the query string carries - a hosted invoice link is signed, and the console is the one
    * place in this app a screenshot puts it in front of somebody else.</p>
    */
   public async openExternalLink( url: string) {

    try {
      await this.links.open(url);
    } catch (error) {
      console.error("Failed to open link:", error);
    }
  }
}
