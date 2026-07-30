/**
 * Join-time gating only. A member who met the bar when they joined is never
 * re-checked, and raising the level does not retroactively restrict anyone.
 */
export enum GuildVerificationLevel {
    None = 'None',
    Low = 'Low',
    Medium = 'Medium',
    High = 'High',
}

export interface AutoModConfig {
    enabled: boolean;
    /** Whole-word, case-insensitive matches. No regex or wildcards server-side. */
    blockedWords: string[];
    /** Null means no rate limit. Must be set together with intervalSeconds or the PUT 400s. */
    maxMessagesPerInterval?: number | null;
    intervalSeconds?: number | null;
}

export interface OnboardingConfig {
    enabled: boolean;
    /** Required (400 otherwise) when enabled is true. Rendered as plain text, not markdown. */
    rulesText?: string | null;
    /** Advisory only - highlights channels in the rules screen, grants no visibility. */
    defaultChannelIds: string[];
}

export interface OnboardingStatus {
    completed: boolean;
    rulesText?: string | null;
    defaultChannelIds: string[];
}
