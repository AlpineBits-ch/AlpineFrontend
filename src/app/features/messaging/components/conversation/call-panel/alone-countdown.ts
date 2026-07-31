/**
 * Copy for the banner shown while the local user is the only one left in a call and the server
 * is counting down to force-ending it.
 *
 * A wall-clock time rather than a live countdown: the panel has no ticking timer, and "ends at
 * 14:35" answers the only question the user has without introducing one.
 */
export function formatAloneNotice(deadline: Date | null): string | null {
    if (!deadline || Number.isNaN(deadline.getTime())) return null;
    const at = deadline.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    return `Waiting for others to rejoin - call ends at ${at}`;
}
