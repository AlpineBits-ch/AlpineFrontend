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
    /**
     * True when this row is a bare Remove proposal rather than a commit.
     *
     * Read from the wire rather than inferred from what the engine makes of the bytes. A proposal
     * advances nobody's epoch, so counting one as progress re-fetches it from the same
     * `sinceEpoch` forever. The server's epoch index is also filtered on `is_proposal = false`, so
     * a proposal and the real commit behind it legitimately share an epoch - the sequence check has
     * to know which is which *before* it looks at the number.
     */
    isProposal?: boolean;
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
    /**
     * Set when the payload is a bare Remove proposal a departing device published for someone else
     * to commit, rather than a commit.
     *
     * The server does not advance the group's epoch for it. Omitting the flag is what produced the
     * non-terminating catch-up: the epoch moved to a number no client could ever reach, so every
     * member re-fetched the same proposal forever and no later commit was accepted again.
     */
    isProposal?: boolean;
}

export interface MlsCommitPublishedDto {
    contextId: string;
    conversationId?: string | null;
    generation: number;
    epoch: number;
    /** Echoes whether the stored row was a proposal, so a successful publish is not mistaken for
     * the group having moved. */
    isProposal?: boolean;
    /**
     * True when the server already held this exact commit from this device and returned the stored
     * row rather than writing a second one. The publish succeeded - the client must keep its
     * merged state rather than treating it as a lost race and discarding it.
     */
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
    /**
     * True when the only package left for the device was its reusable last-resort one.
     *
     * Worth saying out loud: a leaf admitted on a last-resort package has no forward secrecy from
     * that point back, because the same init key can seal more than one Welcome. It is still far
     * better than the device being unreachable.
     */
    isLastResort?: boolean;
    /**
     * The device's certificate, issued by its owner's account identity key, travelling with the
     * key package so the server cannot pair one device's package with another's certificate.
     *
     * Carried through but **not validated here** - certificate enforcement is deliberately not
     * implemented on this client yet, and validating without the three-state policy that gates it
     * would have clients proposing the removal of every device in the field. See contract §H.4/§I.1.
     */
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
    /**
     * Evidence that this device is in the group, not proof that it is not.
     *
     * The server computes it from a Welcome addressed to the device in this generation, a commit
     * published from it, or the record that it built the group. A device that joined by external
     * commit leaves none of those and reads as false while decrypting perfectly, so false means
     * *ask the device*, never *assert a fault*.
     */
    covered: boolean;
}

/**
 * Who can and cannot read a context, asked long after the moment it was decided.
 *
 * The three responses that already carried this - create, enable, and the commit that admits
 * someone - are each handed to one client for a few seconds. This is the same question asked again,
 * by any participant, at any time.
 */
export interface MlsCoverageDto {
    contextId: string;
    /** False when the context has no live group. Both lists are then empty and mean nothing is
     * outside anything - not that everybody is outside. */
    encrypted: boolean;
    /** Which group the answer is about. Null when {@link encrypted} is false. */
    generation?: number | null;
    /** Every active device on the caller's account, with a verdict each. */
    ownDevices: OwnDeviceCoverageDto[];
    /**
     * Other participants' devices holding no leaf. Only the uncovered ones appear, so this is not a
     * directory of everyone's hardware. Always empty for a channel, whose roster Messaging cannot
     * enumerate.
     */
    unreachableDevices: UnreachableDeviceDto[];
    /**
     * True when the device list could not be read at all - a sibling service was down.
     *
     * Both lists then come back empty *because nothing could be looked up*, which is the one
     * reading that must never be rendered as "all clear".
     */
    coverageUnavailable?: boolean;
}

export interface ConsumeTokensResultDto {
    deviceTokens: MlsDeviceTokenDto[];
    /**
     * Devices with no key package left. They were not added to the group and will never be able to
     * read the context - the user has to be told, not silently short-changed.
     */
    unreachableDevices: UnreachableDeviceDto[];
}
