import type {Activity} from '../../models/activity.model';
import {Presence, PresenceRpcStatus} from '../ports/presence.port';

/**
 * Detection and the local RPC server, via the Rust `presence` module.
 *
 * <p>Every command name here is the one `rich_presence.rs` registers, unchanged - this adapter moved
 * the `invoke` calls out of `RichPresenceService` without renaming or reshaping any of them, so the
 * Rust side and the mobile client are unaffected.</p>
 */
export class TauriPresence extends Presence {
    readonly supported = true;

    async current(): Promise<Activity[]> {
        const {invoke} = await import('@tauri-apps/api/core');
        return invoke<Activity[]>('presence_current');
    }

    /**
     * <p>`null` is normalised to `[]` here rather than at the call site: the event payload is
     * `Activity[] | null` because Rust serialises "no activity" as `null`, and every subscriber wants
     * the same empty list out of it.</p>
     */
    async onChanged(handler: (activities: Activity[]) => void): Promise<() => void> {
        const {listen} = await import('@tauri-apps/api/event');
        return listen<Activity[] | null>('presence://changed', event => handler(event.payload ?? []));
    }

    async scan(): Promise<string | null> {
        const {invoke} = await import('@tauri-apps/api/core');
        return invoke<string | null>('scan_game_process');
    }

    async rpcStart(mode: 'proxy' | 'exclusive'): Promise<PresenceRpcStatus> {
        const {invoke} = await import('@tauri-apps/api/core');
        return invoke<PresenceRpcStatus>('presence_rpc_start', {mode});
    }

    async rpcStop(): Promise<PresenceRpcStatus> {
        const {invoke} = await import('@tauri-apps/api/core');
        return invoke<PresenceRpcStatus>('presence_rpc_stop');
    }
}
