export interface ProfileDto {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    userName: string;
    bio: string | undefined;
    userId: string;
    avatarUrl: string | undefined;
    bannerUrl: string | undefined;
    accentColor: string | null;
    font: ProfileFont;
    onlineStatus: OnlineStatus;

    // ── Visibility-gated fields (§10) ────────────────────────────────────────
    //
    // Each is governed by the subject's own privacy setting, and a field the viewer may not see is
    // ABSENT FROM THE PAYLOAD ENTIRELY - not null, not an empty array. That distinction is the
    // whole contract: `profile.mutualFriends.length` throws for a viewer who is merely not
    // permitted, so every read must be optional and every empty state must mean "none to show"
    // rather than "none exist". Optional here for exactly that reason.

    mutualFriends?: MinimalProfileSummary[];
    mutualServers?: MutualServerSummary[];
    /** Linked external accounts. A list, not a Steam field - more types are expected. */
    connections?: ProfileConnection[];
    /** ISO date. The gate is live but no data source is wired yet, so absent for now. */
    birthday?: string;
    /** The gate is live but no data source is wired yet, so absent for now. */
    activity?: ProfileActivity;
}

export interface MinimalProfileSummary {
    id: string;
    userId: string;
    userName: string;
    avatarUrl?: string;
}

export interface MutualServerSummary {
    guildId: string;
    name: string;
    iconUrl?: string;
}

export interface ProfileConnection {
    type: string;
    externalId: string;
    displayName?: string;
    verified: boolean;
}

export interface ProfileActivity {
    type?: string;
    name?: string;
    details?: string;
    startedAt?: string;
}

export enum OnlineStatus {
    Offline = 'Offline',
    Hidden = 'Hidden',
    Online = 'Online',
    Idle = 'Idle',
    DoNotDisturb = 'DoNotDisturb',
}

export enum ProfileFont {
    Default = 'Default',
    Serif = 'Serif',
    Monospace = 'Monospace',
    Rounded = 'Rounded',
    Display = 'Display',
    Handwritten = 'Handwritten',
}