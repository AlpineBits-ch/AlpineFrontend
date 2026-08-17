/** The payment-handle wire contract. */

/** One member's sealed blob, as visible to the calling device. */
export interface SealedPaymentHandles {
    userId: string;
    /** Base64. */
    ciphertext: string;
    /** Base64. */
    nonce: string;
    version: number;
    /** The roster as it stood when this was sealed. */
    memberRosterVersion: number;
    updatedAt: string;
    /** The content key sealed to the calling device, base64, or null. */
    wrappedKey?: string | null;
}

/** One member's phone number, shown because they opted in for this household. */
export interface SharedPhoneNumber {
    userId: string;
    /** E.164, normalised by Identity on write. Not necessarily a Swiss number. */
    phoneNumber: string;
    /** When the owner last wrote it. */
    updatedAt: string;
}

export interface PaymentHandleDirectory {
    guildId: string;
    /** The device the wraps were selected for. */
    deviceId: string;
    memberRosterVersion: number;
    members: SealedPaymentHandles[];
    /** The plaintext numbers of the members who opted in for this household. */
    phoneNumbers: SharedPhoneNumber[];
    /** The caller's own opt-in, echoed so the toggle renders without a second round trip. */
    sharingPhoneNumber: boolean;
}

/** Turns the caller's own number on or off for one guild. */
export interface SetPhoneSharingDto {
    share: boolean;
}

export interface PhoneSharingResult {
    guildId: string;
    sharingPhoneNumber: boolean;
}

/** One device to seal to, with everything needed to decide whether to. */
export interface PaymentHandleRecipient {
    userId: string;
    deviceId: string;
    deviceName?: string | null;
    /** Base64 of the device's long-term Ed25519 identity key. Not an MLS KeyPackage init key. */
    publicKey: string;
    /** Identity's verdict on the device's certificate. See `device-trust.ts` for what we do with it. */
    hasValidCertificate: boolean;
    /** Set when the certificate was pulled - the device was removed, or the certificate reissued. */
    certificateRevokedAt?: string | null;
    /** False for a device its owner marked removed. Flagged, never filtered. */
    isActive: boolean;
    /** The certificate bytes, base64. */
    certificate?: string | null;
    certificateIssuedAt?: string | null;
    certificateExpiresAt?: string | null;
    identityKeyVersion?: number | null;
}

export interface PaymentHandleRecipients {
    guildId: string;
    /** Seal with this, and store it as the blob's roster version. */
    memberRosterVersion: number;
    recipients: PaymentHandleRecipient[];
    /** Members Identity declined to answer for because the roster was over its batch cap. */
    unresolvedMemberIds: string[];
}

export interface PaymentHandleWrapDto {
    recipientUserId: string;
    recipientDeviceId: string;
    /** Base64. */
    wrappedKey: string;
}

export interface SealPaymentHandlesDto {
    /** Base64. Capped at 8 KiB server-side. */
    ciphertext: string;
    /** Base64. Capped at 64 bytes. */
    nonce: string;
    version: number;
    /** At most 200. An empty list is legal and means "sealed to nobody yet". */
    wraps: PaymentHandleWrapDto[];
}

export interface SealPaymentHandlesResult {
    guildId: string;
    userId: string;
    memberRosterVersion: number;
}

/** What the server refuses, mirrored so a write is not attempted that cannot succeed. */
export const PAYMENT_HANDLE_LIMITS = {
    maxCiphertextBytes: 8 * 1024,
    maxNonceBytes: 64,
    maxWraps: 200,
    maxWrappedKeyBytes: 1024,
} as const;

// ── Realtime (server -> client) ─────────────────────────────────────────────

/** `guild.PaymentHandlesChanged`, broadcast guild-wide when somebody seals or deletes. */
export interface PaymentHandlesChanged {
    guildId: string;
    userId: string;
    memberRosterVersion?: number;
    /** Set on a delete. Absent on a seal. */
    removed?: boolean;
}
