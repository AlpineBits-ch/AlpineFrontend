import {OnlineStatus} from '../dtos/response/profile.dto';

/**
 * How each status is named to the user.
 * `Hidden` and `Offline` must share a label, or the UI leaks the distinction Hidden exists to hide.
 */
export const ONLINE_STATUS_LABEL_KEYS: Record<OnlineStatus, string> = {
    [OnlineStatus.Online]: 'STATUS.ONLINE',
    [OnlineStatus.Idle]: 'STATUS.IDLE',
    [OnlineStatus.DoNotDisturb]: 'STATUS.DND',
    [OnlineStatus.Hidden]: 'STATUS.INVISIBLE',
    [OnlineStatus.Offline]: 'STATUS.INVISIBLE',
};

/** The translation key naming a status, or null when there is no status to name. */
export function statusLabelKey(status: OnlineStatus | null | undefined): string | null {
    return status ? (ONLINE_STATUS_LABEL_KEYS[status] ?? null) : null;
}

/**
 * The statuses a user can put themselves into, in the order they are offered.
 * {@link OnlineStatus.Offline} is absent: it is observed, never chosen.
 */
export const SELECTABLE_STATUSES: readonly OnlineStatus[] = [
    OnlineStatus.Online,
    OnlineStatus.Idle,
    OnlineStatus.DoNotDisturb,
    OnlineStatus.Hidden,
];
