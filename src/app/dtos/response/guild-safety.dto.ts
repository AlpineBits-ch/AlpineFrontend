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

// ── Onboarding ───────────────────────────────────────────────────────────────

/**
 * Advisory only - mirrors Discord's flag for whether channels reachable through
 * prompt options count toward "what a newcomer can see". The server stores it but
 * enforces no minimum-channel requirement.
 */
export enum OnboardingMode {
    Default = 'Default',
    Advanced = 'Advanced',
}

export enum OnboardingPromptType {
    MultipleChoice = 'MultipleChoice',
    Dropdown = 'Dropdown',
}

export interface OnboardingPromptOption {
    /** Omit to create; round-trip an existing "onbo_..." to update in place. */
    id?: string;
    title: string;
    description?: string | null;
    /** A unicode emoji, or a guild emoji id. */
    emoji?: string | null;
    /** Granted when picked. Privileged roles are rejected at save time - see the guide's §2.4. */
    roleIds: string[];
    /** Made visible when picked. This, not defaultChannelIds, is what grants access. */
    channelIds: string[];
    position: number;
}

export interface OnboardingPrompt {
    /** Omit to create; round-trip an existing "onbp_..." to update in place. */
    id?: string;
    title: string;
    type: OnboardingPromptType;
    /** true = radio, false = checkboxes. */
    singleSelect: boolean;
    /** Must be answered before onboarding can be finished. */
    required: boolean;
    /** false = only in Channels & Roles, never in the join flow. */
    inOnboarding: boolean;
    position: number;
    options: OnboardingPromptOption[];
}

export interface OnboardingConfig {
    enabled: boolean;
    mode: OnboardingMode;
    /** Rendered as plain text, not markdown. Required when enabled unless a prompt is. */
    rulesText?: string | null;
    /** Advisory only - highlights channels in the join flow, grants no visibility. */
    defaultChannelIds: string[];
    prompts: OnboardingPrompt[];
}

/** What the joining member sees. Only prompts with inOnboarding: true are included. */
export interface OnboardingStatus {
    /**
     * false means this guild has no onboarding at all - never show the flow.
     * Optional because a server still on the v1 payload omits it entirely; see
     * GuildOnboardingStateService.pendingForGuild for how that case is resolved.
     */
    enabled?: boolean;
    completed: boolean;
    rulesText?: string | null;
    defaultChannelIds: string[];
    prompts: OnboardingPrompt[];
}

/** Every prompt, with the member's current picks marked. Used by Channels & Roles. */
export interface MemberPrompt extends OnboardingPrompt {
    options: (OnboardingPromptOption & {selected: boolean})[];
}

export interface OnboardingResponse {
    promptId: string;
    optionIds: string[];
}

// ── Welcome screen ───────────────────────────────────────────────────────────

export interface WelcomeChannel {
    channelId: string;
    /** 50 chars. */
    description: string;
    emoji?: string | null;
    position: number;
}

export interface WelcomeScreen {
    enabled: boolean;
    /** 140 chars. */
    description?: string | null;
    channels: WelcomeChannel[];
}

// ── Moderation ───────────────────────────────────────────────────────────────

export interface PendingMember {
    memberId: string;
    userId: string;
    nickname?: string | null;
    joinedAt: string;
}

/** Server-enforced caps, mirrored so the settings screen can flag problems inline. */
export const ONBOARDING_LIMITS = {
    rulesTextLength: 4000,
    defaultChannels: 25,
    promptsPerGuild: 10,
    optionsPerPrompt: 25,
    rolesPerOption: 10,
    channelsPerOption: 10,
    titleLength: 100,
    descriptionLength: 100,
    welcomeChannels: 5,
    welcomeDescriptionLength: 140,
    welcomeChannelDescriptionLength: 50,
} as const;
