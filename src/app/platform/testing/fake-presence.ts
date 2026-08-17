import type {Activity} from '../../models/activity.model';
import {Presence, PresenceRpcStatus} from '../ports/presence.port';

/** A bound `discord-ipc-0`, which is the only status worth having as a default. */
export const BOUND_RPC_STATUS: PresenceRpcStatus = {
    running: true,
    mode: 'proxy',
    endpoint: '\\\\?\\pipe\\discord-ipc-0',
    index: 0,
    connections: 0,
    maxConnections: 16,
};

/**
 * A {@link Presence} for specs, provided in TestBed in place of an adapter.
 *
 * <p>Replaces the `vi.mock('@tauri-apps/api/core')` + `vi.mock('@tauri-apps/api/event')` pair
 * `rich-presence.service.spec.ts` used to hoist. Those two were module-global, so several spec files
 * registering a mock for the same module fought over one registration per run - a fake in `providers` is
 * scoped to its own TestBed and invisible to every other file.</p>
 *
 * <p>Calls are recorded as `[method, ...args]` rather than as one spy per method, because most
 * assertions about this port are "how many times, and with what" - one readable array beats six mocks.</p>
 */
export class FakePresence extends Presence {
    supported = true;

    readonly calls: unknown[][] = [];

    /** What {@link scan} answers - a bare title, or null for "no game". */
    game: string | null = null;

    /** What {@link current} answers: the arbiter's state for a subscriber arriving mid-game. */
    activities: Activity[] = [];

    /** What the RPC pair answers when it succeeds. */
    rpcStatus: PresenceRpcStatus = BOUND_RPC_STATUS;

    /** Set to make {@link rpcStart} reject, the way a pipe Discord already holds does. */
    rpcStartFails = false;

    /** While true, {@link scan} does not resolve until {@link resolveScan} is called. */
    holdScan = false;

    /** Fires `presence://changed`. Null until something has subscribed. */
    emit: ((activities: Activity[]) => void) | null = null;

    private pendingScan: ((game: string | null) => void) | null = null;

    async current(): Promise<Activity[]> {
        this.calls.push(['current']);
        return this.activities;
    }

    async onChanged(handler: (activities: Activity[]) => void): Promise<() => void> {
        this.calls.push(['onChanged']);
        this.emit = handler;
        return () => {
            this.emit = null;
        };
    }

    async scan(): Promise<string | null> {
        this.calls.push(['scan']);
        if (!this.holdScan) return this.game;
        return new Promise<string | null>(resolve => {
            this.pendingScan = resolve;
        });
    }

    async rpcStart(mode: 'proxy' | 'exclusive'): Promise<PresenceRpcStatus> {
        this.calls.push(['rpcStart', mode]);
        if (this.rpcStartFails) throw new Error('pipe busy');
        return this.rpcStatus;
    }

    async rpcStop(): Promise<PresenceRpcStatus> {
        this.calls.push(['rpcStop']);
        return {...this.rpcStatus, running: false};
    }

    /** Answers a scan being held open, for the "a scan was already in flight" race. */
    resolveScan(game: string | null): void {
        this.pendingScan?.(game);
        this.pendingScan = null;
    }

    /** Fires `presence://changed`, failing loudly rather than silently if nothing subscribed. */
    change(activities: Activity[]): void {
        if (!this.emit) throw new Error('nothing has subscribed to presence://changed');
        this.emit(activities);
    }

    /** Every call to `method`, as its argument list. */
    callsTo(method: string): unknown[][] {
        return this.calls.filter(call => call[0] === method).map(call => call.slice(1));
    }
}
