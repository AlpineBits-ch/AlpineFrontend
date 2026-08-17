/**
 * Writes a byte payload somewhere the user can find it.
 *
 * `false` means a known cancellation, never "probably failed".
 */
export abstract class FileSaver {
    /** Returns false when the user cancelled. */
    abstract save(suggestedName: string, data: Uint8Array | string, mime?: string): Promise<boolean>;

    /**
     * Save bytes that are expensive to produce, without paying for them if the user cancels.
     *
     * A caller must not assume `produce` ran: a `false` from a host with a real dialog means it did not.
     */
    abstract saveLazy(
        suggestedName: string,
        produce: () => Promise<Uint8Array>,
        mime?: string,
    ): Promise<boolean>;
}
