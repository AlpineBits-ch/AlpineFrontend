import {LinkOpener} from '../ports/link-opener.port';

/**
 * A {@link LinkOpener} for specs, provided in TestBed in place of an adapter.
 *
 * <p>Records every URL and opens nothing, which is also what makes it safe: the real web adapter calls
 * `window.open`, and a spec that let that through would spawn tabs out of a test runner.</p>
 *
 * <p><b>It deliberately accepts any URL.</b> Which schemes are openable is an adapter decision that
 * differs by host - a browser must refuse `javascript:`, while the desktop shell hands the string to the
 * OS - so a fake that filtered would be asserting one host's rule inside every caller's spec. Those rules
 * are tested where they live, in `platform/web/link-opener.web.spec.ts`.</p>
 */
export class FakeLinkOpener extends LinkOpener {
    /** Every URL asked for, in order. */
    readonly opened: string[] = [];

    /** Set to make {@link open} reject - no handler for the scheme, or the shell refused. */
    error: Error | null = null;

    override async open(url: string): Promise<void> {
        this.opened.push(url);
        if (this.error) throw this.error;
    }
}
