import {ed25519, x25519} from '@noble/curves/ed25519.js';

/** Sealing and opening the payment-handle blob. */

/** Bumped only for a wire-incompatible change. The server stores it and hands it back unread. */
export const PAYMENT_HANDLE_ENVELOPE_VERSION = 1;

const CONTENT_KEY_BYTES = 32;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BITS = 128;
/** Version byte, ephemeral X25519 public key, wrap nonce, then the sealed content key plus tag. */
const WRAP_BYTES = 1 + 32 + GCM_NONCE_BYTES + CONTENT_KEY_BYTES + GCM_TAG_BITS / 8;

const CONTENT_INFO = 'alpine.payment-handles.content.v1';
const WRAP_INFO = 'alpine.payment-handles.wrap.v1';

/** One device to seal to. `publicKey` is base64 of the raw 32-byte Ed25519 identity key. */
export interface SealRecipient {
    userId: string;
    deviceId: string;
    publicKey: string;
}

export interface SealedWrap {
    recipientUserId: string;
    recipientDeviceId: string;
    /** Base64. The shape the server's `PaymentHandleWrapDto.WrappedKey` takes on the wire. */
    wrappedKey: string;
}

export interface SealedEnvelope {
    /** Base64. */
    ciphertext: string;
    /** Base64. */
    nonce: string;
    version: number;
    wraps: SealedWrap[];
}

/** A refusal that must never be reported as a transient failure - see each thrower for why. */
export class PaymentCryptoError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PaymentCryptoError';
    }
}

/**
 * Encrypts the handle list once and wraps the content key to every recipient device.
 *
 * @throws PaymentCryptoError when a recipient key is not a usable Ed25519 point. Never silently
 *         skipped: a caller who believes they sealed to Ben's two phones and reached one has a
 *         worse problem than one who was told the write did not happen.
 */
export async function sealPaymentHandles(
    plaintext: string,
    recipients: readonly SealRecipient[],
    guildId: string,
    ownerUserId: string,
): Promise<SealedEnvelope> {
    const contentKeyBytes = crypto.getRandomValues(new Uint8Array(CONTENT_KEY_BYTES));
    const nonce = crypto.getRandomValues(new Uint8Array(GCM_NONCE_BYTES));

    const contentKey = await crypto.subtle.importKey(
        'raw', toArrayBuffer(contentKeyBytes), 'AES-GCM', false, ['encrypt']);

    const ciphertext = await crypto.subtle.encrypt(
        {
            name: 'AES-GCM',
            iv: toArrayBuffer(nonce),
            additionalData: toArrayBuffer(contentAad(guildId, ownerUserId)),
            tagLength: GCM_TAG_BITS,
        },
        contentKey,
        toArrayBuffer(new TextEncoder().encode(plaintext)),
    );

    const wraps: SealedWrap[] = [];
    for (const recipient of recipients) {
        wraps.push({
            recipientUserId: recipient.userId,
            recipientDeviceId: recipient.deviceId,
            wrappedKey: toBase64(await wrapContentKey(contentKeyBytes, recipient)),
        });
    }

    return {
        ciphertext: toBase64(new Uint8Array(ciphertext)),
        nonce: toBase64(nonce),
        version: PAYMENT_HANDLE_ENVELOPE_VERSION,
        wraps,
    };
}

/**
 * Opens one member's blob with the wrap addressed to this device.
 *
 * @param ownPrivateKey base64 of this device's raw 32-byte Ed25519 seed, as stored in the OS
 *        keychain under `alpine_mls_{deviceId}_priv`.
 * @throws PaymentCryptoError on any failure. **Not distinguished by cause on purpose**: a wrong key,
 *         a tampered tag and a truncated blob are the same answer to the user - "this cannot be
 *         opened here" - and reporting which would let a caller with a stolen blob probe the
 *         difference.
 */
export async function openPaymentHandles(
    envelope: {ciphertext: string; nonce: string; version: number},
    wrappedKey: string,
    ownPrivateKey: string,
    ownDeviceId: string,
    guildId: string,
    ownerUserId: string,
): Promise<string> {
    if (envelope.version !== PAYMENT_HANDLE_ENVELOPE_VERSION) {
        // A newer envelope is not a corrupt one, and the difference is worth keeping: the UI can
        // say "this was written by a newer version of the app" rather than implying tampering.
        throw new PaymentCryptoError(
            `Envelope version ${envelope.version} is not one this build can open`);
    }

    const contentKeyBytes = await unwrapContentKey(wrappedKey, ownPrivateKey, ownDeviceId);

    try {
        const contentKey = await crypto.subtle.importKey(
            'raw', toArrayBuffer(contentKeyBytes), 'AES-GCM', false, ['decrypt']);

        const plaintext = await crypto.subtle.decrypt(
            {
                name: 'AES-GCM',
                iv: toArrayBuffer(fromBase64(envelope.nonce)),
                additionalData: toArrayBuffer(contentAad(guildId, ownerUserId)),
                tagLength: GCM_TAG_BITS,
            },
            contentKey,
            toArrayBuffer(fromBase64(envelope.ciphertext)),
        );

        return new TextDecoder().decode(plaintext);
    } catch {
        throw new PaymentCryptoError('The sealed payment handles could not be opened');
    }
}

// ── Wrapping ────────────────────────────────────────────────────────────────

async function wrapContentKey(
    contentKeyBytes: Uint8Array,
    recipient: SealRecipient,
): Promise<Uint8Array> {
    const recipientX = toMontgomeryPublic(recipient.publicKey, recipient.deviceId);

    const ephemeralSecret = x25519.utils.randomSecretKey();
    const ephemeralPublic = x25519.getPublicKey(ephemeralSecret);
    const shared = agree(ephemeralSecret, recipientX);

    const wrapKey = await deriveWrapKey(shared, ephemeralPublic, recipientX, recipient.deviceId,
        ['encrypt']);
    const wrapNonce = crypto.getRandomValues(new Uint8Array(GCM_NONCE_BYTES));

    const sealed = new Uint8Array(await crypto.subtle.encrypt(
        {
            name: 'AES-GCM',
            iv: toArrayBuffer(wrapNonce),
            additionalData: toArrayBuffer(new TextEncoder().encode(recipient.deviceId)),
            tagLength: GCM_TAG_BITS,
        },
        wrapKey,
        toArrayBuffer(contentKeyBytes),
    ));

    const out = new Uint8Array(WRAP_BYTES);
    out[0] = PAYMENT_HANDLE_ENVELOPE_VERSION;
    out.set(ephemeralPublic, 1);
    out.set(wrapNonce, 33);
    out.set(sealed, 45);
    return out;
}

async function unwrapContentKey(
    wrappedKey: string,
    ownPrivateKey: string,
    ownDeviceId: string,
): Promise<Uint8Array> {
    const bytes = fromBase64(wrappedKey);
    if (bytes.length !== WRAP_BYTES || bytes[0] !== PAYMENT_HANDLE_ENVELOPE_VERSION) {
        throw new PaymentCryptoError('The wrapped key is not in a form this build can open');
    }

    const ephemeralPublic = bytes.slice(1, 33);
    const wrapNonce = bytes.slice(33, 45);
    const sealed = bytes.slice(45);

    const seed = fromBase64(ownPrivateKey);
    if (seed.length !== 32) {
        // The keychain holds the raw Ed25519 seed. Anything else is a different key material
        // format, and guessing at it would derive a key that silently opens nothing.
        throw new PaymentCryptoError('This device\'s identity key is not a 32-byte Ed25519 seed');
    }

    const ownX = ed25519.utils.toMontgomerySecret(seed);
    const ownXPublic = x25519.getPublicKey(ownX);
    const shared = agree(ownX, ephemeralPublic);

    const wrapKey = await deriveWrapKey(shared, ephemeralPublic, ownXPublic, ownDeviceId,
        ['decrypt']);

    try {
        return new Uint8Array(await crypto.subtle.decrypt(
            {
                name: 'AES-GCM',
                iv: toArrayBuffer(wrapNonce),
                additionalData: toArrayBuffer(new TextEncoder().encode(ownDeviceId)),
                tagLength: GCM_TAG_BITS,
            },
            wrapKey,
            toArrayBuffer(sealed),
        ));
    } catch {
        throw new PaymentCryptoError('The wrapped key is not addressed to this device');
    }
}

/** HKDF-SHA256 over the agreed secret, salted with both public keys and bound to the device id. */
async function deriveWrapKey(
    shared: Uint8Array,
    ephemeralPublic: Uint8Array,
    staticPublic: Uint8Array,
    deviceId: string,
    usages: KeyUsage[],
): Promise<CryptoKey> {
    const material = await crypto.subtle.importKey(
        'raw', toArrayBuffer(shared), 'HKDF', false, ['deriveKey']);

    const salt = new Uint8Array(ephemeralPublic.length + staticPublic.length);
    salt.set(ephemeralPublic, 0);
    salt.set(staticPublic, ephemeralPublic.length);

    return crypto.subtle.deriveKey(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: toArrayBuffer(salt),
            info: toArrayBuffer(new TextEncoder().encode(`${WRAP_INFO}|${deviceId}`)),
        },
        material,
        {name: 'AES-GCM', length: 256},
        false,
        usages,
    );
}

/** X25519 agreement, refusing the all-zero output. */
function agree(secret: Uint8Array, publicKey: Uint8Array): Uint8Array {
    let shared: Uint8Array;
    try {
        shared = x25519.getSharedSecret(secret, publicKey);
    } catch (cause) {
        throw new PaymentCryptoError(
            `The key exchange failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    }

    if (shared.every(byte => byte === 0)) {
        throw new PaymentCryptoError('The key exchange produced a degenerate shared secret');
    }
    return shared;
}

/** Maps a device's Ed25519 identity key onto Curve25519 so it can be agreed against. */
function toMontgomeryPublic(publicKeyBase64: string, deviceId: string): Uint8Array {
    let raw: Uint8Array;
    try {
        raw = fromBase64(publicKeyBase64);
    } catch {
        throw new PaymentCryptoError(`Device ${deviceId} has a public key that is not base64`);
    }

    if (raw.length !== 32) {
        throw new PaymentCryptoError(
            `Device ${deviceId} has a ${raw.length}-byte key, which is not an Ed25519 public key`);
    }

    try {
        return ed25519.utils.toMontgomery(raw);
    } catch (cause) {
        throw new PaymentCryptoError(
            `Device ${deviceId} has a key that is not a valid Ed25519 point: `
            + `${cause instanceof Error ? cause.message : String(cause)}`);
    }
}

// ── Encoding ────────────────────────────────────────────────────────────────

function contentAad(guildId: string, ownerUserId: string): Uint8Array {
    return new TextEncoder().encode(`${CONTENT_INFO}|${guildId}|${ownerUserId}`);
}

/** A standalone `ArrayBuffer` view of a `Uint8Array`. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.slice().buffer as ArrayBuffer;
}

export function toBase64(bytes: Uint8Array): string {
    let binary = '';
    // Chunked: `String.fromCharCode(...bytes)` on a large array overflows the argument list, and
    // the sealed payload is bounded but not tiny.
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}
