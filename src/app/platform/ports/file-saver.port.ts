/**
 * Writes a byte payload somewhere the user can find it.
 *
 * <p>Desktop asks for a path and writes it; web hands the bytes to a download. The two differ in a
 * way callers must not have to know about: the desktop dialog can be cancelled and the browser
 * download cannot be observed at all, so "false" means *known* cancellation and never "probably
 * failed".</p>
 */
export abstract class FileSaver {
    /** Returns false when the user cancelled. */
    abstract save(suggestedName: string, data: Uint8Array | string, mime?: string): Promise<boolean>;

    /**
     * Save bytes that are expensive to produce, without paying for them if the user cancels.
     *
     * <p>`produce` is invoked only once a destination is known, on hosts that can know one before
     * writing. On web there is no such point, so it is invoked first and the result streamed to a
     * download - the browser has no cancellation signal to wait for anyway.</p>
     *
     * <p>Use this wherever the bytes cost something to obtain - a download, a large export - and
     * {@link save} where they are already in hand. A caller must not assume `produce` ran: a `false`
     * answer from a host with a real dialog means it did not.</p>
     */
    abstract saveLazy(
        suggestedName: string,
        produce: () => Promise<Uint8Array>,
        mime?: string,
    ): Promise<boolean>;
}
