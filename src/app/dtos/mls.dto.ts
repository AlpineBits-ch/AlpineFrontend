/** Wire shapes for the server-side MLS transport. A context is a conversation or a guild channel. */

/** Base64 in JSON; the server models these as `byte[]`. */
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
    /** Epoch the joining device lands on, where its commit catch-up starts. */
    epoch: number;
    consumedAt?: string | null;
}

export interface MlsCommitDto {
    id: string;
    contextId: string;
    conversationId?: string | null;
    channelId?: string | null;
    generation: number;
    /** Group epoch after this commit is applied. */
    epoch: number;
    commit: Base64;
    senderUserId: string;
    senderDeviceId: string;
    createdAt: string;
    /** True when this row is a bare Remove proposal rather than a commit. A proposal advances no epoch. */
    isProposal?: boolean;
}

export interface PublishMlsCommitDto {
    epoch: number;
    commit: Base64;
    senderDeviceId: string;
    /** Which generation the commit was built against. Always send it; omitting it assumes the live one. */
    generation?: number;
    /** Refreshed GroupInfo so a device that falls too far behind can rejoin by external commit. */
    groupInfo?: Base64 | null;
    welcomes: DeviceWelcomeDto[];
    /** Join requests this commit admits; the server closes them only once it lands. */
    fulfilledJoinRequestIds?: string[];
    /** Set when the payload is a bare Remove proposal rather than a commit. The server advances no epoch for it. */
    isProposal?: boolean;
}

export interface MlsCommitPublishedDto {
    contextId: string;
    conversationId?: string | null;
    generation: number;
    epoch: number;
    /** Echoes whether the stored row was a proposal, so a publish is not mistaken for the group moving. */
    isProposal?: boolean;
    /** True when the server already held this exact commit. The publish succeeded; keep the merged state. */
    duplicate?: boolean;
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
    /** Every era the context has had, oldest first, including terminated ones. */
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
    /** Set on disable: messages from this era stay ciphertext. */
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

/** 409 body when a toggle is refused: already in that state, or still inside the cooldown. */
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
    /** True when the only package left for the device was its reusable last-resort one. */
    isLastResort?: boolean;
    /** The device's certificate, issued by its owner's account identity key. Carried through, not validated here. */
    certificate?: Base64 | null;
    certificateExpiresAt?: string | null;
    certificateIdentityKeyVersion?: number | null;
}

export interface UnreachableDeviceDto {
    userId: string;
    deviceId: string;
    deviceName: string;
}

/** One of the caller's own devices, and whether the server can show it got into the group. */
export interface OwnDeviceCoverageDto {
    deviceId: string;
    deviceName: string;
    /** Evidence that this device is in the group, not proof that it is not. False means ask the device. */
    covered: boolean;
}

/** Who can and cannot read a context, askable by any participant at any time. */
export interface MlsCoverageDto {
    contextId: string;
    /** False when the context has no live group. Both lists are then empty and mean nothing. */
    encrypted: boolean;
    /** Which group the answer is about. Null when {@link encrypted} is false. */
    generation?: number | null;
    /** Every active device on the caller's account, with a verdict each. */
    ownDevices: OwnDeviceCoverageDto[];
    /** Other participants' devices holding no leaf. Only the uncovered ones appear. Always empty for a channel. */
    unreachableDevices: UnreachableDeviceDto[];
    /** True when the device list could not be read at all. Empty lists then mean nothing; never render "all clear". */
    coverageUnavailable?: boolean;
}

export interface ConsumeTokensResultDto {
    deviceTokens: MlsDeviceTokenDto[];
    /** Devices with no key package left. They were not added and cannot read the context. */
    unreachableDevices: UnreachableDeviceDto[];
}
