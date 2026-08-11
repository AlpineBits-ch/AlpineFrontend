import {FileSaver} from '../ports/file-saver.port';

/** One recorded {@link FileSaver.save} call, as the port saw it. */
export interface RecordedSave {
    name: string;
    data: Uint8Array | string;
    mime?: string;
}

/**
 * A {@link FileSaver} for specs, provided in TestBed in place of an adapter.
 *
 * <p>Replaces the `vi.mock('@tauri-apps/plugin-dialog')` / `vi.mock('@tauri-apps/plugin-fs')` pairs the
 * saving specs used to hoist. The gain is not tidiness: those mocks pinned a desktop save dialog, so
 * every test written against them was implicitly a desktop test, and the one answer only the browser
 * adapter gives - true, always, because a browser cannot report cancellation - had nowhere to be
 * expressed.</p>
 *
 * <p>Records rather than asserts, so a test can pin the filename and the MIME type the caller chose.
 * Both matter beyond cosmetics: the desktop adapter derives the dialog's file-type filter from the
 * extension in the name, and the MIME type decides whether a browser previews a download or saves it.</p>
 */
export class FakeFileSaver extends FileSaver {
    /** Every save asked for, in order. */
    readonly calls: RecordedSave[] = [];

    /**
     * Set to have {@link save} answer false - the user dismissed a desktop save dialog.
     *
     * <p>Only a desktop adapter can reach this. Leaving it false models the web adapter, which has no
     * cancellation signal at all.</p>
     */
    cancelled = false;

    /** Set to make a save reject: a full disk, or a write the OS refused. */
    error: Error | null = null;

    /**
     * How many times a {@link saveLazy} producer was invoked.
     *
     * <p>The number that matters for the ordering guarantee: a cancelled save must leave this at zero,
     * because the whole point of `saveLazy` is not paying for bytes the user then discards.</p>
     */
    produceCalls = 0;

    /**
     * Model the web adapter's eager ordering instead of the desktop adapter's lazy one.
     *
     * <p>Defaults to the desktop ordering, because that is the behaviour with a promise to keep -
     * `produce` is skipped entirely when {@link cancelled}. Set this to check a caller survives the host
     * that cannot defer: `produce` runs first and `cancelled` is unreachable there anyway.</p>
     */
    produceEagerly = false;

    /** The single recorded call, for the common case. Throws if there was not exactly one. */
    get onlyCall(): RecordedSave {
        if (this.calls.length !== 1) {
            throw new Error(`expected exactly one save, saw ${this.calls.length}`);
        }
        return this.calls[0];
    }

    /** The payload of the single recorded call, decoded as UTF-8 text. */
    onlyCallAsText(): string {
        const {data} = this.onlyCall;
        return typeof data === 'string' ? data : new TextDecoder().decode(data);
    }

    override async save(name: string, data: Uint8Array | string, mime?: string): Promise<boolean> {
        this.calls.push({name, data, mime});
        if (this.error) throw this.error;
        return !this.cancelled;
    }

    override async saveLazy(
        name: string,
        produce: () => Promise<Uint8Array>,
        mime?: string,
    ): Promise<boolean> {
        if (this.produceEagerly) {
            const data = await this.produce(produce);
            this.calls.push({name, data, mime});
            if (this.error) throw this.error;
            return !this.cancelled;
        }

        // The desktop ordering: the dialog is answered before anything is produced, so a cancel returns
        // without the producer ever running and without recording a save.
        if (this.cancelled) return false;

        const data = await this.produce(produce);
        this.calls.push({name, data, mime});
        if (this.error) throw this.error;
        return true;
    }

    private async produce(produce: () => Promise<Uint8Array>): Promise<Uint8Array> {
        this.produceCalls++;
        return produce();
    }
}
