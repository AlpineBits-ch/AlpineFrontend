/**
 * The account's privacy record, mirroring Identity's `UserPrivacySettings`.
 *
 * <p>Every member is string-valued because the API serializes C# enums by name - the same reason
 * {@link RelationshipStatus} is written this way. A numeric member would silently fail to match
 * the literal the server sends.</p>
 *
 * <p>Ordering is permissive-to-restrictive so "at least as restrictive as" is a comparison, which
 * is what the minor floor (T1-11) needs to express.</p>
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
 *
 * <p>`version` is the server's write counter. It is echoed on the change event so a consumer can
 * tell whether the copy it holds is older than the one an event announces, rather than trusting a
 * delivery order nobody controls.</p>
 */
export interface PrivacySettings {
    // Data use - consent, opt-in, never opt-out.
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

/**
 * A partial write. Every field is optional and an omitted field means "leave alone" - the endpoint
 * takes no read-modify-write from the client, so two settings pages open at once cannot clobber
 * each other's unrelated fields.
 */
export type PrivacySettingsPatch = Partial<Omit<PrivacySettings, 'version'>>;

/**
 * What the client assumes before the server has answered.
 *
 * <p>These mirror the server's column defaults, but they are <b>not</b> a substitute for them: the
 * page does not let anything be written while the real record is unknown (see
 * {@link PrivacySettingsService}). They exist so the UI has a shape to render, not so it can
 * pretend to know the user's choices.</p>
 */
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
 * The machine-readable codes the API returns instead of a bare 403, so the client can tell
 * "you are not allowed" apart from "that was malformed" - and, for the minor floor, tell the user
 * *which* field the server refused.
 *
 * <p>Note the two shapes the code arrives in: the conversation and messaging refusals put it under
 * `error`, while the friend-request and settings refusals use `code`. {@link refusalCode} reads
 * both rather than making every call site remember which family it is talking to.</p>
 */
export const PRIVACY_REFUSAL_CODES = {
    recipientDmPolicy: 'recipient_dm_policy',
    blocked: 'blocked',
    explicitContentFiltered: 'explicit_content_filtered',
    friendRequestPolicy: 'friend_request_policy',
    minorRestriction: 'minor_restriction',
    /** 503, not 403. The policy data was unreachable - the answer is unknown, not "no". */
    privacyLookupUnavailable: 'privacy_lookup_unavailable',
    positionalVoiceConsent: 'positional_voice_consent',
} as const;

/**
 * The longest retention window the server accepts (ten years). `0` and negatives are rejected
 * outright; `null` is the separate, meaningful "keep forever".
 */
export const DM_RETENTION_MAX_DAYS = 3650;
export const DM_RETENTION_MIN_DAYS = 1;
