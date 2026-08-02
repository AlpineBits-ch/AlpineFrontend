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
}