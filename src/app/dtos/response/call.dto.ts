export interface CallDto {
    id: string;
    conversationId: string;
    /** Backend `CallStatus` enum as a string (Pending/Ringing/Rejected/Connected/Completed) -
     *  used to detect a missed `call.CallEnded` event on reconnect. */
    status?: string;
    createdAt: Date;
    updatedAt: Date;
    tracks: CallTack[];
    participants: CallParticipant[];
}

export interface CallTack {
    trackId: string;
    userId: string;
    status: string;
}

export interface CallParticipant {
    userId: string;
    /** Only set once this participant has actually published an audio track -
     *  used to backfill-subscribe on connect/reconnect without waiting for a
     *  live `call.ParticipantJoined` event, which can be missed across a
     *  SignalR reconnect gap. */
    cfSessionId?: string;
    audioTrackName?: string;
}