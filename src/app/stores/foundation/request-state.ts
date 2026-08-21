/** How a keyed fetch failed. `forbidden` is a 403, which a view may render differently from a network failure. */
export type LoadFailure = 'failed' | 'forbidden';

/** One key's fetch bookkeeping. No record at all means no fetch was ever issued for that key. */
export interface KeyedRequest {
    loading: boolean;
    /** Epoch ms of the last success. `0` covers both invalidated and failed, so a retry is never blocked. */
    loadedAt: number;
    error: LoadFailure | null;
    /** Set by an invalidation or a failure. A request in flight while this is set is already known stale. */
    stale: boolean;
    /** A refetch asked for while this key's request was still in flight. */
    pendingRefetch: boolean;
    /**
     * Bumped by every fetch and every invalidation. A response minted under an older one is
     * superseded: its rows still land, but it may not report the key as freshly loaded.
     */
    generation: number;
}
