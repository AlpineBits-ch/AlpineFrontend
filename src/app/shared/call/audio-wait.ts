import {computed, DestroyRef, effect, inject, Signal, signal} from '@angular/core';
import {CallParticipant} from './call.types';

/**
 * How long a remote participant may sit there with no audio before we call it a fault.
 *
 * A participant lands in `participantsWithAudio` only once their subscribe resolves, and that is
 * routinely several seconds out: the backend announces a publisher the moment Cloudflare accepts
 * their tracks, which is one SDP answer before they have finished ICE and DTLS, so the first
 * subscribe attempts fail and back off. Warning during that window is warning about a load.
 */
export const AUDIO_GRACE_MS = 10_000;

/** `connecting` is a loading state; only `stalled` is worth alarming anybody about. */
export type AudioState = 'ok' | 'connecting' | 'stalled';

export interface AudioWait {
    /** Remote participants past the grace window - their audio is probably never coming. */
    readonly stalled: Signal<ReadonlySet<string>>;
    /** True while at least one participant is stalled - for the call-wide banners. */
    readonly anyStalled: Signal<boolean>;

    stateOf(userId: string): AudioState;
}

/**
 * Splits "no audio yet" into "still connecting" and "actually broken".
 *
 * Must be called from an injection context - it owns an effect and a timer per waiting participant,
 * and hangs their cleanup off the caller's lifetime.
 */
export function trackAudioWait(
    participants: Signal<readonly CallParticipant[]>,
    withAudio: Signal<ReadonlySet<string>>,
): AudioWait {
    /** Remote participants we are still waiting on, whether or not the grace window has passed. */
    const pending = computed(() => {
        const audio = withAudio();
        return new Set(
            participants().filter(p => !p.isLocal && !audio.has(p.userId)).map(p => p.userId),
        );
    });

    // Mirrored: the effect below reads `stalledIds` without subscribing to itself, and publishes a
    // copy through the signal. Reading the signal inside the effect that writes it would loop.
    const stalledIds = new Set<string>();
    const stalled = signal<ReadonlySet<string>>(new Set());
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    effect(() => {
        const waiting = pending();
        let changed = false;

        // Audio arrived, or they left. Either way the countdown is void.
        for (const [userId, timer] of timers) {
            if (!waiting.has(userId)) {
                clearTimeout(timer);
                timers.delete(userId);
            }
        }
        for (const userId of stalledIds) {
            if (!waiting.has(userId)) {
                stalledIds.delete(userId);
                changed = true;
            }
        }

        for (const userId of waiting) {
            if (timers.has(userId) || stalledIds.has(userId)) continue;
            timers.set(userId, setTimeout(() => {
                timers.delete(userId);
                stalledIds.add(userId);
                stalled.set(new Set(stalledIds));
            }, AUDIO_GRACE_MS));
        }

        if (changed) stalled.set(new Set(stalledIds));
    });

    inject(DestroyRef).onDestroy(() => {
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
    });

    return {
        stalled: stalled.asReadonly(),
        anyStalled: computed(() => stalled().size > 0),
        stateOf: (userId: string): AudioState => {
            if (!pending().has(userId)) return 'ok';
            return stalled().has(userId) ? 'stalled' : 'connecting';
        },
    };
}
