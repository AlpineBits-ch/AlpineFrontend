export interface CallDto {
    id: string;
    conversationId: string;
    /** Who placed the call. The reliable way to name the caller on the incoming-call card:
     *  "the participant that isn't me" picks an arbitrary one of them once a call has three
     *  people in it. Optional only because the field is newer than this interface. */
    creatorId?: string;
    /** Backend `CallStatus` enum (Pending/Ringing/Rejected/Connected/Completed/Left) - used to
     *  detect a missed `call.CallEnded` event on reconnect. `number` because a host without
     *  `JsonStringEnumConverter` sends the ordinal; run it through `callStatusName()` rather than
     *  comparing raw. */
    status?: string | number;
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
    mediaSessionId?: string;
    audioTrackName?: string;
    /** Per-participant `CallStatus`, same dual string/ordinal encoding as {@link CallDto.status}.
     *  Carried by `call.CallDeclined`, which is how the caller tells "the callee said no" from
     *  "one of three invitees said no and the rest are still ringing". */
    status?: string | number;
}