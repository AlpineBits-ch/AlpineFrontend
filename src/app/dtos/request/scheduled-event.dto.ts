export interface CreateScheduledEventDto {
    title: string;
    description?: string | null;
    startsAt: string;
    endsAt?: string | null;
    location?: string | null;
    voiceChannelId?: string | null;
}

/** PATCH semantics: only the fields you send are touched. */
export type UpdateScheduledEventDto = Partial<CreateScheduledEventDto>;
