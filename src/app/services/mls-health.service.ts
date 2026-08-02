import {computed, Injectable, signal} from '@angular/core';

/** Why a context is not readable on this device. */
export type MlsFailureReason =
    /** A Welcome arrived but joining the group from it failed. */
    | 'join-failed'
    /** The context is encrypted server-side and this device holds no group for it. */
    | 'not-admitted'
    /** We hold the group but a message would not decrypt. */
    | 'decrypt-failed'
    /** Someone else's commit removed this device from the group. */
    | 'removed'
    /**
     * The server reports this context as unencrypted, and this device knows better.
     *
     * <p>A context that has ever been encrypted here carries a monotonic floor that nothing on the
     * wire can lower (§L.6). The server answering `{encrypted: false}` above that floor is either a
     * downgrade attempt or a disable this device has not been told about through a path it trusts -
     * and the two are indistinguishable from here, so both refuse cleartext.</p>
     */
    | 'downgraded';

export interface MlsContextHealth {
    contextId: string;
    isChannel: boolean;
    reason: MlsFailureReason;
    /** How many times it has failed since the last success. A one-off reads very differently. */
    failures: number;
    lastFailureAt: number;
    /** Engine error text, for the log and for a details view. Never shown as the primary message. */
    detail?: string;
}

/**
 * What this device cannot read, and why.
 *
 * <p>Every one of these used to be a `console.error` or a bare `catch {}`. That is why the
 * double-base64 bug shipped and stayed shipped: a device that could never join a conversation
 * logged one line per launch and showed its owner nothing, so the only symptom anyone could
 * report was "sometimes messages don't arrive".</p>
 *
 * <p>Deliberately a counted, addressable state rather than a toast. The useful question is not
 * "did a decrypt fail" - one will, at the edge of the ratchet - but "is this context readable on
 * this device at all", which is answered by whether failures keep accruing without a success in
 * between.</p>
 */
@Injectable({providedIn: 'root'})
export class MlsHealthService {
    private readonly _contexts = signal<Record<string, MlsContextHealth>>({});

    /** Every context currently in a failed state. */
    readonly unhealthy = computed(() => Object.values(this._contexts()));

    /** True when at least one context cannot be read - the cue for a global re-link affordance. */
    readonly hasFailures = computed(() => this.unhealthy().length > 0);

    /**
     * Threshold past which a context is presented as broken rather than as a hiccup.
     *
     * One failure is ordinary: a message paged in from beyond the ratchet's reach cannot be
     * decrypted and never will be, and that is correct MLS behaviour rather than a fault.
     */
    private static readonly BROKEN_AFTER = 3;

    healthOf(contextId: string): MlsContextHealth | null {
        return this._contexts()[contextId] ?? null;
    }

    /** Whether the UI should stop offering to send and offer to re-link instead. */
    isBroken(contextId: string): boolean {
        const health = this.healthOf(contextId);
        if (!health) return false;
        return health.reason === 'removed'
            || health.reason === 'not-admitted'
            // Immediately, not after three. There is no "hiccup" reading of a server that claims a
            // context this device has encrypted is now plaintext, and the user has to see it before
            // they type the next message rather than after the third one.
            || health.reason === 'downgraded'
            || health.failures >= MlsHealthService.BROKEN_AFTER;
    }

    recordFailure(
        contextId: string,
        isChannel: boolean,
        reason: MlsFailureReason,
        detail?: unknown,
    ): void {
        this._contexts.update(current => {
            const previous = current[contextId];
            return {
                ...current,
                [contextId]: {
                    contextId,
                    isChannel,
                    reason,
                    // Reset on a change of reason: "we were never admitted" and "one old message
                    // would not decrypt" are different problems and must not add up into one count.
                    failures: previous?.reason === reason ? previous.failures + 1 : 1,
                    lastFailureAt: Date.now(),
                    detail: describe(detail),
                },
            };
        });
    }

    /** Called on any successful read or join. Clears the context's failed state. */
    recordSuccess(contextId: string): void {
        if (!this._contexts()[contextId]) return;
        this._contexts.update(current => {
            const next = {...current};
            delete next[contextId];
            return next;
        });
    }

    clear(): void {
        this._contexts.set({});
    }
}

function describe(detail: unknown): string | undefined {
    if (detail === undefined || detail === null) return undefined;
    if (detail instanceof Error) return detail.message;
    return typeof detail === 'string' ? detail : JSON.stringify(detail);
}
