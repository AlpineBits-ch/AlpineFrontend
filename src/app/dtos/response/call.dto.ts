export interface CallDto {
    id: string;
    conversationId: string;
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
}