/**
 * The payment-handle wire contract.
 *
 * <p>Kept inside this feature rather than in `src/app/dtos`, because none of it is shared: every
 * other consumer of a household DTO reads fields, and there is nothing readable here. The server's
 * side of these four routes is metadata and opaque bytes - whose row it is, which guild, when it
 * changed - and that is deliberate: there is no plaintext IBAN column, no provider column, no
 * validation of either, and no code anywhere in Guild that builds a payment link.</p>
 *
 * <p><b>`byte[]` on the server is base64 on the wire.</b> System.Text.Json serialises a byte array
 * as a base64 string, so every field below that the C# DTO types as `byte[]` is a `string` here.</p>
 */

/** One member's sealed blob, as visible to the calling device. */
export interface SealedPaymentHandles {
    userId: string;
    /** Base64. */
    ciphertext: string;
    /** Base64. */
    nonce: string;
    version: number;
    /**
     * The roster as it stood when this was sealed.
     *
     * <p>Compare against {@link PaymentHandleDirectory.memberRosterVersion}. A blob carrying an
     * older value has not been re-sealed since somebody joined or left, which is what explains a
     * missing {@link wrappedKey} without it being a fault.</p>
     */
    memberRosterVersion: number;
    updatedAt: string;
    /**
     * The content key sealed to the calling device, base64, or null.
     *
     * <p><b>Null is an ordinary state and must never be rendered as an error.</b> Somebody who
     * joined the house yesterday has no wrap from anybody until each of them re-seals, and the
     * right thing on screen is "Anna hasn't shared how to pay her with you yet".</p>
     *
     * <p>Singular rather than a list because the response only ever carries this device's wrap.
     * Other devices' wraps are useless here, and how many devices a person has is metadata worth
     * not handing out.</p>
     */
    wrappedKey?: string | null;
}

/**
 * One member's phone number, shown because they opted in for this household.
 *
 * <p><b>This is plaintext, and that is the whole reason it is a separate type.</b> The server read
 * it out of Identity, could log it, and anybody with the database has it.
 * {@link SealedPaymentHandles} is ciphertext the server cannot open. The two arrive in one response
 * and must not be tidied into one list: they carry genuinely different protections, and somebody
 * deciding whether to share a number is entitled to know which kind they are agreeing to.</p>
 *
 * <p><b>Nothing verified it.</b> There is no `isVerified` field here and there never will be - SMS
 * verification was designed and dropped, so the number is exactly what its owner typed. A flag
 * whose only possible value is false is a badge that teaches people to ignore badges. Where it
 * matters, the UI says plainly that the number is what its owner entered, in the same breath as
 * showing it.</p>
 */
export interface SharedPhoneNumber {
    userId: string;
    /** E.164, normalised by Identity on write. Not necessarily a Swiss number. */
    phoneNumber: string;
    /**
     * When the owner last wrote it.
     *
     * <p>With nothing verifying the number, how recently it was touched is the only signal there
     * is. A weak one, surfaced because the alternative is none.</p>
     */
    updatedAt: string;
}

export interface PaymentHandleDirectory {
    guildId: string;
    /**
     * The device the wraps were selected for.
     *
     * <p>Echoed back so a client that sent the wrong `X-Device-Id` can tell, rather than concluding
     * that nobody has shared with it. Worth actually checking: the two states look identical.</p>
     */
    deviceId: string;
    memberRosterVersion: number;
    members: SealedPaymentHandles[];
    /**
     * The plaintext numbers of the members who opted in for this household.
     *
     * <p><b>A member absent from this list has either not opted in or has no number, and the
     * response deliberately does not say which.</b> The two produce field-for-field identical
     * responses - somebody who has not consented is never named on the bus to Identity at all - so
     * there is nothing here to tell them apart with, and no UI may imply otherwise. In particular
     * "Anna has not shared her number" is the wrong sentence, because it asserts that Anna has
     * one.</p>
     */
    phoneNumbers: SharedPhoneNumber[];
    /**
     * The caller's own opt-in, echoed so the toggle renders without a second round trip.
     *
     * <p>Only ever the caller's own. Whether anybody else opted in is visible from
     * {@link phoneNumbers} and not otherwise.</p>
     */
    sharingPhoneNumber: boolean;
}

/**
 * Turns the caller's own number on or off for one guild.
 *
 * <p>An explicit boolean rather than a toggle route, so a client retrying a request it is unsure
 * landed cannot flip the setting back. What is being switched decides who sees a phone number, and
 * "I pressed it twice" must not be how it ends up shared.</p>
 */
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
    /**
     * The certificate bytes, base64.
     *
     * <p><b>Optional because the Guild endpoint does not forward them yet.</b> Identity's bus
     * contract carries `Certificate`, `CertificateIssuedAt`, `CertificateExpiresAt` and
     * `IdentityKeyVersion` specifically so a caller can verify {@link publicKey} offline against a
     * pinned account identity key instead of taking {@link hasValidCertificate} as the server's
     * word - and carries them in the same message so the server cannot pair one device's key with
     * another's certificate. `PaymentHandleEndpoint.RecipientsAsync` currently selects only the two
     * boolean-ish fields and drops these. Modelled here so that adding them is a server change
     * alone.</p>
     */
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
    /**
     * Members Identity declined to answer for because the roster was over its batch cap.
     *
     * <p>Non-empty means the recipient list is incomplete, and sealing against it would leave those
     * people out. Empty is the only case in which the list can be treated as the whole house.</p>
     */
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

/**
 * `guild.PaymentHandlesChanged`, broadcast guild-wide when somebody seals or deletes.
 *
 * <p>State replication, never a notification: it carries no readable content, and raising an alert
 * because a flatmate edited their bank details would be both noise and a disclosure of when they
 * did it.</p>
 */
export interface PaymentHandlesChanged {
    guildId: string;
    userId: string;
    memberRosterVersion?: number;
    /** Set on a delete. Absent on a seal. */
    removed?: boolean;
}
