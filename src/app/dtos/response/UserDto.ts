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
    createdAt: Date;
    updatedAt: Date;
    birthDate: Date;
    phoneVerifiedAt: Date | undefined;
    emailVerifiedAt: Date | undefined;
    ageVerification: unknown;
    encryptedMasterKey: EncryptedMasterKey | undefined;
}