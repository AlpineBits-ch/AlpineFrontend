export enum UserType {
    Standard = 'Standard',
    Admin = 'Admin',
}

export enum AccountStatus {
    Active = 'Active',
    PendingDeletion = 'PendingDeletion',
    PurgeInProgress = 'PurgeInProgress',
    Deleted = 'Deleted',
    Inactive = 'Inactive',
    Banned = 'Banned',
}

export interface EncryptedMasterKey {
    cipherText: string;
    salt: string;
    iv: string;
    argon2Iterations: number;
    argon2Memory: number;
    argon2Parallelism: number;
    version: number;
    /**
     * `HKDF-SHA256(masterKey, "", "venta.masterkey.verifier.v1", 32)`, base64 (contract §L.11).
     *
     * <p>Derived inside the engine beside the wrapping, and identical across both wrappings of one
     * key and across every re-wrap of it - which is what lets the server check that a
     * `rewrap-password` seals the key it already holds blobs for. Optional because envelopes stored
     * before §L.11 have none, and no reader may require it.</p>
     */
    publicVerifier?: string | null;
}

/**
 * What an account said it came here for, at onboarding.
 *
 * <p>Serialised as the lowercase wire values of the server's `[Flags] UserInterests`, which is
 * why these are strings and not a bitfield - the flags enum is a storage detail of the Identity
 * context and nothing here benefits from reproducing it.</p>
 */
export enum UserInterest {
    Isle = 'isle',
    Social = 'social',
}

export interface UserDto {
    id: string;
    email: string;
    userType: UserType;
    createdAt: Date;
    updatedAt: Date;
    birthDate: Date;
    phoneVerifiedAt: Date | undefined;
    emailVerifiedAt: Date | undefined;
    ageVerification: unknown;
    encryptedMasterKey: EncryptedMasterKey | undefined;
    steamId: string | undefined;
    status: AccountStatus;
    deletionRequestedAt: Date | undefined;
    purgeScheduledAt: Date | undefined;
    /**
     * Inherited from IdentityUser server-side and already present on the /users/self
     * payload - there is no dedicated MFA-status endpoint. Optional because a
     * self-hosted server on an older build predating MFA won't send it at all.
     */
    twoFactorEnabled?: boolean;
    /**
     * When the account answered the "what do you want to use Venta for" picker, or null/absent if
     * it never has.
     *
     * <p>Optional, and absence must be read as *onboarded*, not as *needs onboarding*. A
     * self-hosted server on a build predating this feature sends neither this nor
     * {@link interests}, and treating that as "not onboarded yet" would gate every one of its
     * users behind a picker whose submit endpoint answers 404.</p>
     */
    onboardedAt?: string | null;
    /**
     * Which halves of the product this account signed up for. Decides whether master-key setup
     * runs at launch or is deferred to the first social action - see `SocialKeyGateService`.
     */
    interests?: UserInterest[];
}