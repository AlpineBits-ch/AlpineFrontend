/**
 * Who may DM this account. String-valued because the API serializes C# enums by name.
 * Declared permissive to restrictive, and compared in that order; do not reorder.
 */
export enum DirectMessagePolicy {
    Everyone = 'Everyone',
    FriendsAndServerMembers = 'FriendsAndServerMembers',
    Friends = 'Friends',
    Nobody = 'Nobody',
}

/** Who may send this account a friend request. */
export enum FriendRequestPolicy {
    Everyone = 'Everyone',
    FriendsOfFriends = 'FriendsOfFriends',
    ServerMembers = 'ServerMembers',
    Nobody = 'Nobody',
}

/** Who can see one profile field. Enforced in the server's projection, not here. */
export enum Visibility {
    Everyone = 'Everyone',
    Friends = 'Friends',
    Nobody = 'Nobody',
}

/** Which DM attachments get run past a media classifier before they are shown. */
export enum ExplicitContentFilter {
    Off = 'Off',
    UnknownSenders = 'UnknownSenders',
    Everyone = 'Everyone',
}

/**
 * The full settings record as `GET /api/v1/identity/privacy-settings` returns it.
 * `version` is the server's write counter, echoed on the change event.
 */
export interface PrivacySettings {
    // Data use: consent, opt-in, never opt-out.
    allowDataCollection: boolean;
    allowPersonalization: boolean;
    allowVoiceRecordingInClips: boolean;

    // Contactability.
    directMessagePolicy: DirectMessagePolicy;
    friendRequestPolicy: FriendRequestPolicy;

    // Discoverability.
    discoverableByUsername: boolean;
    discoverableByEmail: boolean;
    discoverableByPhone: boolean;

    // Profile field visibility.
    mutualServersVisibility: Visibility;
    mutualFriendsVisibility: Visibility;
    connectionsVisibility: Visibility;
    birthdayVisibility: Visibility;

    // Presence & activity.
    shareActivity: boolean;
    allowPositionalVoiceCapture: boolean;

    // Messaging behaviour.
    sendReadReceipts: boolean;
    sendTypingIndicators: boolean;
    /** Null means keep forever. Applies only to messages this account sent. */
    dmRetentionDays: number | null;

    // Safety.
    explicitContentFilter: ExplicitContentFilter;

    // Push.
    hidePushContent: boolean;

    version: number;
}

/** A partial write. Every field is optional and an omitted field means "leave alone". */
export type PrivacySettingsPatch = Partial<Omit<PrivacySettings, 'version'>>;

/** What the client assumes before the server has answered. A shape to render, not the user's real choices. */
export const PRIVACY_SETTINGS_DEFAULTS: PrivacySettings = {
    allowDataCollection: false,
    allowPersonalization: false,
    allowVoiceRecordingInClips: false,

    directMessagePolicy: DirectMessagePolicy.Friends,
    friendRequestPolicy: FriendRequestPolicy.Everyone,

    discoverableByUsername: true,
    discoverableByEmail: false,
    discoverableByPhone: false,

    mutualServersVisibility: Visibility.Friends,
    mutualFriendsVisibility: Visibility.Friends,
    connectionsVisibility: Visibility.Friends,
    birthdayVisibility: Visibility.Nobody,

    shareActivity: true,
    allowPositionalVoiceCapture: true,

    sendReadReceipts: true,
    sendTypingIndicators: true,
    dmRetentionDays: null,

    explicitContentFilter: ExplicitContentFilter.UnknownSenders,

    hidePushContent: false,

    version: 0,
};

/**
 * The machine-readable codes the API returns instead of a bare 403.
 * They arrive under `error` on messaging refusals and under `code` on the rest.
 */
export const PRIVACY_REFUSAL_CODES = {
    recipientDmPolicy: 'recipient_dm_policy',
    blocked: 'blocked',
    explicitContentFiltered: 'explicit_content_filtered',
    friendRequestPolicy: 'friend_request_policy',
    minorRestriction: 'minor_restriction',
    /** 503, not 403. The policy data was unreachable, so the answer is unknown, not "no". */
    privacyLookupUnavailable: 'privacy_lookup_unavailable',
    positionalVoiceConsent: 'positional_voice_consent',
} as const;

/** The longest retention window the server accepts (ten years). `null` means "keep forever". */
export const DM_RETENTION_MAX_DAYS = 3650;
export const DM_RETENTION_MIN_DAYS = 1;
