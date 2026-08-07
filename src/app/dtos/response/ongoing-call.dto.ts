/**
 * A call in progress in a conversation, as described to a member who is not in it.
 *
 * <p>Deliberately narrower than {@link CallDto}: no `mediaSessionId` and no `audioTrackName`. Those are
 * a live capability over media on a shared Cloudflare Calls app, and the server withholds them from
 * anyone who has not actually joined - they arrive over SignalR once you have. Nothing here can be
 * used to pull a track, which is the point.</p>
 */
export interface OngoingCallDto {
    callId: string;
    conversationId: string;

    /** `Pending` while it is still ringing, `Connected` once somebody answered. */
    status: 'Pending' | 'Connected';
    creatorId: string;
    startedAt: string;
    connectedUserIds: string[];
}

/**
 * `conversation.CallStateChanged` - sent to every member of the conversation, including members who
 * were never invited to the call. The counterpart to the snapshot read above.
 */
export interface CallStateChangedEvent {
    conversationId: string;
    callId: string;
    status: 'Ongoing' | 'Ended';
    reason: string | null;
    participantIds: string[];
}
