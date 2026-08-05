import {OnlineStatus} from '../dtos/response/profile.dto';

/**
 * How each status is named to the user.
 *
 * <p>`Hidden` and `Offline` share a label deliberately. They are different facts — one is a choice,
 * the other is an observation — but they are the same *appearance*, and the whole point of Hidden is
 * that a reader cannot tell which of the two they are looking at. Naming them differently in the UI
 * would leak the distinction the status exists to hide.</p>
 *
 * <p>The label for Hidden is "Invisible", not the older "Appear Offline": it has to work as a
 * present-tense statement of what you currently are ("Invisible") as well as an option you can pick,
 * because the bottom bar renders it as the line under your own name.</p>
 */
export const ONLINE_STATUS_LABEL_KEYS: Record<OnlineStatus, string> = {
    [OnlineStatus.Online]: 'STATUS.ONLINE',
    [OnlineStatus.Idle]: 'STATUS.IDLE',
    [OnlineStatus.DoNotDisturb]: 'STATUS.DND',
    [OnlineStatus.Hidden]: 'STATUS.INVISIBLE',
    [OnlineStatus.Offline]: 'STATUS.INVISIBLE',
};

/**
 * The translation key naming a status, or nothing when there is no status to name.
 *
 * <p>Returns null rather than defaulting to "Online" for an absent profile. A surface that has not
 * loaded yet should render a skeleton, not a confident claim that you are online — which is exactly
 * the class of small lie this whole change is about removing.</p>
 */
export function statusLabelKey(status: OnlineStatus | null | undefined): string | null {
    return status ? ONLINE_STATUS_LABEL_KEYS[status] ?? null : null;
}

/**
 * The statuses a user can put themselves into, in the order they are offered.
 *
 * <p>{@link OnlineStatus.Offline} is absent on purpose: it is observed, never chosen. Someone who
 * wants to look offline picks {@link OnlineStatus.Hidden}, which is a different thing on the wire
 * and is what keeps the session alive while they do it.</p>
 */
export const SELECTABLE_STATUSES: readonly OnlineStatus[] = [
    OnlineStatus.Online,
    OnlineStatus.Idle,
    OnlineStatus.DoNotDisturb,
    OnlineStatus.Hidden,
];
