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