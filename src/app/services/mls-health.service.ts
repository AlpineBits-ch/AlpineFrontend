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
    /** The server reports this context as unencrypted, and this device knows better: a context encrypted here carries a monotonic floor nothing on the wire can lower (§L.6), so anything above it refuses cleartext. */
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

/** What this device cannot read, and why. A counted, addressable state rather than a toast: the useful question is whether failures keep accruing without a success in between. */
@Injectable({providedIn: 'root'})
export class MlsHealthService {
    private readonly _contexts = signal<Record<string, MlsContextHealth>>({});

    /** Every context currently in a failed state. */
    readonly unhealthy = computed(() => Object.values(this._contexts()));

    /** True when at least one context cannot be read: the cue for a global re-link affordance. */
    readonly hasFailures = computed(() => this.unhealthy().length > 0);

    /** Threshold past which a context is presented as broken rather than as a hiccup. One failure is ordinary: a message paged in from beyond the ratchet's reach never decrypts, and that is correct MLS behaviour. */
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
            // Immediately, not after three: there is no "hiccup" reading of a server claiming an encrypted context is now plaintext.
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
                    // Reset on a change of reason: different problems must not add up into one count.
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
