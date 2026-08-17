import {fromBase64} from './payment-handle-crypto';

/** Deciding whether a device is one we are willing to seal somebody's banking to. */

/** What the recipients endpoint says about one device. */
export interface RecipientAttestation {
    userId: string;
    deviceId: string;
    deviceName?: string | null;
    /** Base64 of the raw 32-byte Ed25519 identity key. */
    publicKey: string;
    hasValidCertificate: boolean;
    certificateRevokedAt?: string | null;
    isActive: boolean;
    /**
     * The device certificate, base64, issued by its owner's account identity key over
     * {@link publicKey}.
     */
    certificate?: string | null;
    certificateIssuedAt?: string | null;
    certificateExpiresAt?: string | null;
    /** Which generation of the account identity key signed the certificate. */
    identityKeyVersion?: number | null;
}

/** A place where the server's own account of a device does not add up. */
export type AttestationInconsistency =
    /** The flag says the device is certificated and no certificate was supplied. */
    | 'certificate-missing'
    /** The flag says valid and the certificate's own expiry has already passed. */
    | 'certificate-expired'
    /** The certificate claims to have been issued after it expires. */
    | 'certificate-dates-reversed'
    /** The account identity key version went backwards, which no rotation does. */
    | 'identity-key-version-regressed'
    /** The account identity key version moved. Legitimate after a rotation, worth showing. */
    | 'identity-key-version-changed';

/** How much a device has proved, worst first. */
export type TrustLevel =
    /** The key is not one we can seal to at all - wrong length, not a curve point. */
    | 'unusable'
    /** We sealed to this device before under a different key. The one case that means attack. */
    | 'key-changed'
    /** The server's account of this device contradicts itself. See {@link AttestationInconsistency}. */
    | 'attestation-inconsistent'
    /** The certificate was pulled: the device was removed, or its certificate was reissued. */
    | 'revoked'
    /** Its owner marked it removed. */
    | 'inactive'
    /** No valid certificate. Common for a device registered before certificates, and not proof of anything. */
    | 'unattested'
    /** Certificate valid, nothing contradictory, and either newly seen or matching the pin. */
    | 'attested';

export interface RecipientTrust {
    attestation: RecipientAttestation;
    level: TrustLevel;
    /** The eighty-bit fingerprint, in the same format the MLS review screens print. */
    fingerprint: string;
    /** The fingerprint we pinned previously, when {@link level} is `key-changed`. */
    previousFingerprint: string | null;
    /** Everything about the server's account of this device that does not add up. */
    inconsistencies: AttestationInconsistency[];
    /** True the first time this device is seen, so the UI can word a first seal differently. */
    firstSeen: boolean;
    /** Whether sealing to this device needs the user to agree first. */
    needsConfirmation: boolean;
}

/** What was remembered about a device at the last seal. */
export interface DevicePin {
    /** Base64 identity key. */
    publicKey: string;
    /** The account identity key generation that signed its certificate, when one was reported. */
    identityKeyVersion?: number;
}

/** `deviceId -> pin`. */
export type DevicePins = Readonly<Record<string, DevicePin>>;

/** Classifies one device against what we already knew about it. */
export function classifyRecipient(
    attestation: RecipientAttestation,
    fingerprint: string,
    pins: DevicePins,
    previousFingerprint: string | null,
    now: Date = new Date(),
): RecipientTrust {
    const pinned = pins[attestation.deviceId] ?? null;
    const firstSeen = pinned === null;

    const inconsistencies = findInconsistencies(attestation, pinned, now);
    const level = decideLevel(attestation, pinned, fingerprint, inconsistencies);

    return {
        attestation,
        level,
        fingerprint,
        previousFingerprint: level === 'key-changed' ? previousFingerprint : null,
        inconsistencies,
        firstSeen,
        needsConfirmation: level !== 'attested',
    };
}

/** The server's account of a device, checked against itself. */
function findInconsistencies(
    attestation: RecipientAttestation,
    pinned: DevicePin | null,
    now: Date,
): AttestationInconsistency[] {
    const found: AttestationInconsistency[] = [];

    if (attestation.hasValidCertificate) {
        // Claiming a device is certificated while withholding the certificate is the one shape this
        // check exists to catch: before the bytes were forwarded it was indistinguishable from an
        // honest answer, and now it is not.
        if (!attestation.certificate) found.push('certificate-missing');

        const expires = parseDate(attestation.certificateExpiresAt);
        if (expires && expires.getTime() <= now.getTime()) found.push('certificate-expired');

        const issued = parseDate(attestation.certificateIssuedAt);
        if (issued && expires && issued.getTime() > expires.getTime()) {
            found.push('certificate-dates-reversed');
        }
    }

    const version = attestation.identityKeyVersion;
    const pinnedVersion = pinned?.identityKeyVersion;
    if (typeof version === 'number' && typeof pinnedVersion === 'number' && version !== pinnedVersion) {
        // Rotations only ever go up. Backwards is not a state a real account key reaches, so it is
        // reported as its own thing rather than folded into "the version moved".
        found.push(version < pinnedVersion
            ? 'identity-key-version-regressed'
            : 'identity-key-version-changed');
    }

    return found;
}

function decideLevel(
    attestation: RecipientAttestation,
    pinned: DevicePin | null,
    fingerprint: string,
    inconsistencies: readonly AttestationInconsistency[],
): TrustLevel {
    if (!fingerprint) return 'unusable';

    // Checked before the certificate flags, and deliberately. A key that changed under a device we
    // have already sealed to is the shape of an actual substitution attack, and it stays the
    // headline even when the new key arrives with a perfectly valid certificate - which is exactly
    // what a server that can mint certificates would send.
    if (pinned !== null && pinned.publicKey !== attestation.publicKey) return 'key-changed';

    // Ranked above revocation and absence, because those are ordinary states of an honest directory
    // and this is the directory disagreeing with itself.
    if (inconsistencies.length > 0) return 'attestation-inconsistent';

    if (attestation.certificateRevokedAt) return 'revoked';
    if (!attestation.isActive) return 'inactive';
    if (!attestation.hasValidCertificate) return 'unattested';

    return 'attested';
}

function parseDate(value: string | null | undefined): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * The eighty-bit fingerprint of a device key, in the format the rest of the app already prints.
 *
 * @returns the empty string for a key that is not a 32-byte value, which {@link decideLevel} reads
 *          as `unusable`. A fingerprint over a malformed key would be a real-looking string for
 *          something nobody can seal to.
 */
export async function fingerprintOf(publicKeyBase64: string): Promise<string> {
    let raw: Uint8Array;
    try {
        raw = fromBase64(publicKeyBase64);
    } catch {
        return '';
    }
    if (raw.length !== 32) return '';

    const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', raw.slice().buffer as ArrayBuffer));

    return formatFingerprint(digest);
}

/** Exposed for tests and for anywhere a digest is already in hand. */
export function formatFingerprint(digest: Uint8Array): string {
    const hex = Array.from(digest.subarray(0, 10))
        .map(byte => byte.toString(16).padStart(2, '0').toUpperCase())
        .join('');

    return (hex.match(/.{1,5}/g) ?? []).join('-');
}

/** The devices a seal would reach, and the ones it would not. */
export interface SealPlan {
    /** Devices that will be sealed to. */
    included: RecipientTrust[];
    /** Devices held back until the user says so. */
    blocked: RecipientTrust[];
    /** Members whose devices the server could not resolve at all. */
    unresolvedMemberIds: string[];
}

export function planSeal(
    trusts: readonly RecipientTrust[],
    confirmedDeviceIds: ReadonlySet<string>,
    unresolvedMemberIds: readonly string[],
): SealPlan {
    const included: RecipientTrust[] = [];
    const blocked: RecipientTrust[] = [];

    for (const trust of trusts) {
        // `unusable` is never confirmable: there is no key to seal to, so agreeing to it would
        // produce a wrap that cannot exist rather than a risk the user accepted.
        const usable = trust.level !== 'unusable';
        const allowed = !trust.needsConfirmation
            || (usable && confirmedDeviceIds.has(trust.attestation.deviceId));

        (allowed ? included : blocked).push(trust);
    }

    return {included, blocked, unresolvedMemberIds: [...unresolvedMemberIds]};
}

/** The pins to store after a successful seal: every device actually written to. */
export function pinsAfterSeal(plan: SealPlan, existing: DevicePins): DevicePins {
    const next: Record<string, DevicePin> = {...existing};

    for (const trust of plan.included) {
        const version = trust.attestation.identityKeyVersion;
        next[trust.attestation.deviceId] = {
            publicKey: trust.attestation.publicKey,
            // Recorded only when the server reported one, so a directory that stops sending the
            // field cannot silently clear the value a later comparison depends on.
            ...(typeof version === 'number' ? {identityKeyVersion: version} : {}),
        };
    }

    return next;
}
