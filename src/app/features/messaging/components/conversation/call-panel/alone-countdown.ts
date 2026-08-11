/**
 * When the server will end a call because the local user is the only one left in it.
 *
 * <p>A wall-clock time rather than a live countdown: the panel has no ticking timer, and "ends at
 * 14:35" answers the only question the user has without introducing one.</p>
 *
 * <p>Returns the formatted time alone, not a sentence. It used to return the whole English string,
 * which meant the one banner in the call surface that had something interesting to say was also
 * the one that could never be translated.</p>
 */
export function formatAloneDeadline(deadline: Date | null): string | null {
    if (!deadline || Number.isNaN(deadline.getTime())) return null;
    return deadline.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
}
