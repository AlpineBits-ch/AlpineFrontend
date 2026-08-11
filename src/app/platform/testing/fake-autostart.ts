import {Autostart} from '../ports/autostart.port';

/**
 * An {@link Autostart} for specs, provided in TestBed in place of an adapter.
 *
 * <p>Defaults to a <b>supported host with autostart off</b>, which is the state a fresh desktop install
 * is in. `supported = true` rather than false on purpose: the interesting assertions are about the
 * reconciliation between the stored setting and what the OS actually has registered, and a fake that
 * reported the web host would make every one of them vacuous.</p>
 *
 * <p>{@link setEnabled} records rather than rejecting, even though the *web* adapter rejects. That
 * rejection is the web adapter's own contract - a resolved write there would be a toggle that moves and
 * does nothing - and it is asserted where it lives, in `platform/web/desktop-only.web.spec.ts`. A caller's
 * spec that wants it says `writeError = ...` in one line.</p>
 */
export class FakeAutostart extends Autostart {
    /** Mutable so one spec can cover both hosts. False models the browser. */
    supported = true;

    /** What {@link isEnabled} answers: whether the OS currently holds a launch entry. */
    enabled = false;

    /** Every value written, in order. Two identical writes are two entries - reconciliation churn shows. */
    readonly writes: boolean[] = [];

    /** How many times the OS was asked, so "did this reconcile at all" is answerable. */
    reads = 0;

    /** Set to make {@link isEnabled} reject - a registry read the OS refused. */
    readError: Error | null = null;

    /** Set to make {@link setEnabled} reject, which is what the web adapter always does. */
    writeError: Error | null = null;

    async isEnabled(): Promise<boolean> {
        this.reads++;
        if (this.readError) throw this.readError;
        return this.enabled;
    }

    async setEnabled(enabled: boolean): Promise<void> {
        this.writes.push(enabled);
        if (this.writeError) throw this.writeError;
        this.enabled = enabled;
    }
}
