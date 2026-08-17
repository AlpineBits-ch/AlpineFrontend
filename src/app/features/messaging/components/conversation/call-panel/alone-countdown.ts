/** When the server will end a call because the local user is the only one left in it. */
export function formatAloneDeadline(deadline: Date | null): string | null {
    if (!deadline || Number.isNaN(deadline.getTime())) return null;
    return deadline.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
}
