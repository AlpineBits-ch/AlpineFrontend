/**
 * Wire shapes for the server-side MLS transport.
 *
 * A *context* is a conversation or a guild channel; both carry MLS groups and the endpoints are
 * symmetric apart from who is allowed to call them.
 */

/** Base64 in JSON - the server models these as `byte[]`. */
export type Base64 = string;

export interface DeviceWelcomeDto {
    deviceId: string;
    userId: string;
    /** Base64 TLS-serialized MLS Welcome. */
    welcome: Base64;
}

export interface PendingWelcomeDto {
    id: string;
    contextId: string;
    conversationId?: string | null;
    channelId?: string | null;
    userId: string;
    deviceId: string;
    welcome: Base64;
    /** Which encryption era of the context this Welcome admits us to. */
    generation: number;
    /** Epoch the joining device lands on - where its commit catch-up starts. */
    epoch: number;
    consumedAt?: string | null;
}

export interface MlsCommitDto {
    id: string;
    contextId: string;
    conversationId?: string | null;
    channelId?: string | null;
    generation: number;
    /** Group epoch *after* this commit is applied. */
    epoch: number;
    commit: Base64;
    senderUserId: string;
    senderDeviceId: string;
    createdAt: string;
}

export interface PublishMlsCommitDto {
    epoch: number;
    commit: Base64;
    senderDeviceId: string;
    /**
     * Which generation the commit was built against. Always sent: omitting it makes the server
     * assume the live one, which is exactly wrong if encryption was toggled while we were building.
     */
    generation?: number;
    /** Refreshed GroupInfo so a device that falls too far behind can rejoin by external commit. */
    groupInfo?: Base64 | null;
    welcomes: DeviceWelcomeDto[];
    /** Join requests this commit admits; the server closes them only once it lands. */
    fulfilledJoinRequestIds?: string[];
}

export interface MlsCommitPublishedDto {
    contextId: string;
    conversationId?: string | null;
    generation: number;
    epoch: number;
}

export enum MlsGenerationState {
    Active = 'Active',
    Terminated = 'Terminated',
}

export interface MlsGenerationDto {
    id: string;
    contextId: string;
    generation: number;
    mlsGroupId: Base64;
    mlsGroupInfo?: Base64 | null;
    epoch: number;
    state: MlsGenerationState;
    activatedAt: string;
    activatedByUserId: string;
    terminatedAt?: string | null;
    terminatedByUserId?: string | null;
}

export interface MlsContextStateDto {
    contextId: string;
    encrypted: boolean;
    activeGeneration?: number | null;
    epoch?: number | null;
    mlsGroupId?: Base64 | null;
    mlsGroupInfo?: Base64 | null;
    /**
     * Every era the context has had, oldest first - including terminated ones, whose messages are
     * still sitting in the history. Without them a stretch we cannot decrypt is indistinguishable
     * from corruption.
     */
    generations: MlsGenerationDto[];
}

export interface EnableMlsDto {
    mlsGroupId: Base64;
    epoch: number;
    mlsGroupInfo?: Base64 | null;
    welcomes: DeviceWelcomeDto[];
}

export interface MlsToggleResultDto {
    contextId: string;
    encrypted: boolean;
    generation?: number | null;
    /** Set on disable: messages from this era stay ciphertext and only devices holding that
     * group's keys can still read them. */
    terminatedGeneration?: number | null;
    alreadyInRequestedState?: boolean;
}

/** 409 body when a commit or a send is out of step with the group. */
export interface MlsEpochConflictDto {
    currentEpoch: number;
    rejectedEpoch: number;
    currentGeneration: number;
    rejectedGeneration: number;
    reason: string;
}

/** 409 body when a toggle is refused - already in that state, or still inside the cooldown. */
export interface MlsToggleConflictDto {
    contextId: string;
    encrypted: boolean;
    reason: string;
    retryAfterSeconds?: number | null;
}

/** 409 body when a message's encryption does not match the context's. */
export interface MlsSendConflictDto {
    contextId: string;
    encrypted: boolean;
    activeGeneration?: number | null;
    reason: string;
}

export interface AckWelcomesResultDto {
    acknowledged: number;
}

/** A consumed key package for one of an invitee's devices. */
export interface MlsDeviceTokenDto {
    deviceId: string;
    userId: string;
    token: Base64;
}

export interface UnreachableDeviceDto {
    userId: string;
    deviceId: string;
    deviceName: string;
}

export interface ConsumeTokensResultDto {
    deviceTokens: MlsDeviceTokenDto[];
    /**
     * Devices with no key package left. They were not added to the group and will never be able to
     * read the context - the user has to be told, not silently short-changed.
     */
    unreachableDevices: UnreachableDeviceDto[];
}
