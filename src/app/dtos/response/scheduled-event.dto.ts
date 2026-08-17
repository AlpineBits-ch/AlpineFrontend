export enum ScheduledEventStatus {
    Scheduled = 'Scheduled',
    Active = 'Active',
    Completed = 'Completed',
    Cancelled = 'Cancelled',
}

export interface ScheduledEventDto {
    id: string;
    guildId: string;
    creatorUserId: string;
    title: string;
    description?: string | null;
    /** ISO 8601. */
    startsAt: string;
    endsAt?: string | null;
    /** Freeform text - not mutually exclusive with voiceChannelId. */
    location?: string | null;
    voiceChannelId?: string | null;
    /**
     * Nothing server-side ever moves this off Scheduled except an explicit cancel.
     * Derive "happening now" from startsAt/endsAt, not from this field.
     */
    status: ScheduledEventStatus;
    interestedCount: number;
    isInterested: boolean;
}
