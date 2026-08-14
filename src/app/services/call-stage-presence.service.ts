import {effect, Injectable, Signal, signal} from '@angular/core';

/**
 * Which call stages are currently on screen.
 *
 * <p>The mini-player (Task 8) has to answer one question: is the full view of *this* session already
 * showing? It could try to work that out from the router or from `NavigationService`, but the two
 * stages sit in completely different feature areas - a guild channel view and a docked panel inside
 * a conversation - so a navigation-based answer would have to encode where both of them live and
 * would go quietly wrong the first time either moved. A stage saying "I am up" while it is up is the
 * only signal that cannot drift from the truth.</p>
 *
 * <p>Keys are `scopeKey()` strings (see `ShareWatchService`), so the answer is per session rather
 * than per surface:
 * viewing voice channel B while connected to channel A leaves A's stage unmounted, and the
 * mini-player for A should keep playing. A boolean "a guild stage is showing" would get that
 * wrong.</p>
 *
 * <p>Counted rather than a set of flags, because two registrations for the same key can briefly
 * overlap. Angular creates the incoming view before destroying the outgoing one in some structural
 * swaps - switching conversations while a DM call runs is exactly that - and a flag would flicker
 * off for one change-detection pass, which is long enough for the mini-player to appear and
 * disappear again.</p>
 */
@Injectable({providedIn: 'root'})
export class CallStagePresenceService {
    /** scopeKey -> how many stage instances for it are currently mounted. */
    private readonly mounted = signal<Readonly<Record<string, number>>>({});

    /** Whether a stage for this session is on screen. A null key reads as "no", never as "any". */
    isMounted(key: string | null): boolean {
        return key !== null && (this.mounted()[key] ?? 0) > 0;
    }

    register(key: string): void {
        this.mounted.update(state => ({...state, [key]: (state[key] ?? 0) + 1}));
    }

    unregister(key: string): void {
        this.mounted.update(state => {
            const next = (state[key] ?? 0) - 1;
            const updated = {...state};
            if (next > 0) updated[key] = next;
            else delete updated[key];
            return updated;
        });
    }

    /**
     * Registers a stage for as long as its key reads non-null and the calling context is alive.
     *
     * <p>Call it from the stage's constructor. It is an effect rather than a plain `register()` call
     * there because a stage does not know its own key at construction time: the guild stage's
     * channel arrives as a required input, which is not readable until the first binding pass, and
     * can be swapped underneath the same component instance when the user moves between channels.
     * The cleanup handles the `ngOnDestroy` half - including the case where the key changes while
     * the component lives on, which an `ngOnDestroy` alone would leak.</p>
     */
    track(key: Signal<string | null>): void {
        effect(onCleanup => {
            const current = key();
            if (current === null) return;
            this.register(current);
            onCleanup(() => this.unregister(current));
        });
    }
}
