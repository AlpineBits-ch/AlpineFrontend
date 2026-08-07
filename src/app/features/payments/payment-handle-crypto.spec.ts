import {beforeAll, describe, expect, it} from 'vitest';
import {ed25519} from '@noble/curves/ed25519.js';
import {
    fromBase64,
    openPaymentHandles,
    PAYMENT_HANDLE_ENVELOPE_VERSION,
    PaymentCryptoError,
    sealPaymentHandles,
    SealRecipient,
    toBase64,
} from './payment-handle-crypto';

/**
 * A stand-in for one registered device: an Ed25519 seed in the OS keychain and the matching public
 * key in the server's directory. Exactly the pair `DeviceIdentityService.ensureRegistered` puts
 * there, so what these tests exercise is the real key shape and not a convenient one.
 */
interface TestDevice {
    userId: string;
    deviceId: string;
    /** Base64 of the 32-byte seed, as stored under `alpine_mls_{deviceId}_priv`. */
    privateKey: string;
    /** Base64 of the raw 32-byte public key, as registered as `identityPublicKey`. */
    publicKey: string;
}

function device(userId: string, deviceId: string): TestDevice {
    const seed = ed25519.utils.randomSecretKey();
    return {
        userId,
        deviceId,
        privateKey: toBase64(seed),
        publicKey: toBase64(ed25519.getPublicKey(seed)),
    };
}

function recipientOf(d: TestDevice): SealRecipient {
    return {userId: d.userId, deviceId: d.deviceId, publicKey: d.publicKey};
}

const GUILD = 'guild_ahorn';
const OWNER = 'user_anna';
const PLAINTEXT = JSON.stringify({
    version: 1,
    handles: [{kind: 'Iban', value: 'CH4431999123000889012'}],
});

let anna: TestDevice;
let annaLaptop: TestDevice;
let ben: TestDevice;

beforeAll(() => {
    anna = device(OWNER, 'dev_anna_phone');
    annaLaptop = device(OWNER, 'dev_anna_laptop');
    ben = device('user_ben', 'dev_ben_phone');
});

async function open(
    envelope: Awaited<ReturnType<typeof sealPaymentHandles>>,
    reader: TestDevice,
): Promise<string> {
    const wrap = envelope.wraps.find(w => w.recipientDeviceId === reader.deviceId);
    if (!wrap) throw new Error(`no wrap for ${reader.deviceId}`);
    return openPaymentHandles(
        envelope, wrap.wrappedKey, reader.privateKey, reader.deviceId, GUILD, OWNER);
}

describe('sealPaymentHandles - the round trip', () => {
    it('lets every device it was sealed to read the same plaintext', async () => {
        const sealed = await sealPaymentHandles(
            PLAINTEXT, [anna, annaLaptop, ben].map(recipientOf), GUILD, OWNER);

        expect(sealed.version).toBe(PAYMENT_HANDLE_ENVELOPE_VERSION);
        expect(sealed.wraps).toHaveLength(3);

        for (const reader of [anna, annaLaptop, ben]) {
            expect(await open(sealed, reader)).toBe(PLAINTEXT);
        }
    });

    it('names the recipient user on every wrap, which is what the server checks membership on', async () => {
        const sealed = await sealPaymentHandles(
            PLAINTEXT, [anna, ben].map(recipientOf), GUILD, OWNER);

        expect(sealed.wraps.map(w => [w.recipientUserId, w.recipientDeviceId])).toEqual([
            [OWNER, 'dev_anna_phone'],
            ['user_ben', 'dev_ben_phone'],
        ]);
    });

    it('encrypts once and wraps many times, so a longer roster does not grow the ciphertext', async () => {
        const one = await sealPaymentHandles(PLAINTEXT, [recipientOf(anna)], GUILD, OWNER);
        const three = await sealPaymentHandles(
            PLAINTEXT, [anna, annaLaptop, ben].map(recipientOf), GUILD, OWNER);

        expect(fromBase64(three.ciphertext).length).toBe(fromBase64(one.ciphertext).length);
        expect(three.wraps).toHaveLength(3);
    });

    it('produces a different ciphertext every time, because the key and nonce are fresh', async () => {
        const first = await sealPaymentHandles(PLAINTEXT, [recipientOf(anna)], GUILD, OWNER);
        const second = await sealPaymentHandles(PLAINTEXT, [recipientOf(anna)], GUILD, OWNER);

        expect(first.ciphertext).not.toBe(second.ciphertext);
        expect(first.nonce).not.toBe(second.nonce);
        expect(first.wraps[0].wrappedKey).not.toBe(second.wraps[0].wrappedKey);
    });

    it('seals to nobody at all without failing, which is a legal state', async () => {
        // A client that has not fetched the recipient roster should still be able to store its own
        // details. The server permits an empty wrap list explicitly.
        const sealed = await sealPaymentHandles(PLAINTEXT, [], GUILD, OWNER);
        expect(sealed.wraps).toEqual([]);
        expect(sealed.ciphertext.length).toBeGreaterThan(0);
    });

    it('stays inside the server size caps for a realistic handle list', async () => {
        const sealed = await sealPaymentHandles(
            PLAINTEXT, [anna, annaLaptop, ben].map(recipientOf), GUILD, OWNER);

        expect(fromBase64(sealed.ciphertext).length).toBeLessThanOrEqual(8 * 1024);
        expect(fromBase64(sealed.nonce).length).toBeLessThanOrEqual(64);
        for (const wrap of sealed.wraps) {
            expect(fromBase64(wrap.wrappedKey).length).toBeLessThanOrEqual(1024);
        }
    });
});

describe('openPaymentHandles - what it refuses', () => {
    it('refuses a device the blob was not sealed to', async () => {
        const sealed = await sealPaymentHandles(PLAINTEXT, [recipientOf(anna)], GUILD, OWNER);
        const stranger = device('user_carla', 'dev_carla_phone');

        await expect(openPaymentHandles(
            sealed, sealed.wraps[0].wrappedKey, stranger.privateKey, stranger.deviceId, GUILD, OWNER),
        ).rejects.toThrow(PaymentCryptoError);
    });

    it('refuses a wrap moved from one device row to another', async () => {
        // The device id is bound into both the key derivation and the AEAD additional data, so
        // Ben's wrap presented as Anna's derives a different key and fails the tag.
        const sealed = await sealPaymentHandles(
            PLAINTEXT, [anna, ben].map(recipientOf), GUILD, OWNER);
        const bensWrap = sealed.wraps.find(w => w.recipientDeviceId === ben.deviceId)!;

        await expect(openPaymentHandles(
            sealed, bensWrap.wrappedKey, ben.privateKey, anna.deviceId, GUILD, OWNER),
        ).rejects.toThrow(PaymentCryptoError);
    });

    it('refuses a blob replayed into a different household', async () => {
        // The guild and owner are bound in as additional data. Lifting a row out of one household's
        // table into another's would otherwise decrypt cleanly and present one person's banking as
        // somebody else's.
        const sealed = await sealPaymentHandles(PLAINTEXT, [recipientOf(anna)], GUILD, OWNER);

        await expect(openPaymentHandles(
            sealed, sealed.wraps[0].wrappedKey, anna.privateKey, anna.deviceId,
            'guild_somewhere_else', OWNER),
        ).rejects.toThrow(PaymentCryptoError);
    });

    it('refuses a blob attributed to a different owner', async () => {
        const sealed = await sealPaymentHandles(PLAINTEXT, [recipientOf(anna)], GUILD, OWNER);

        await expect(openPaymentHandles(
            sealed, sealed.wraps[0].wrappedKey, anna.privateKey, anna.deviceId, GUILD, 'user_ben'),
        ).rejects.toThrow(PaymentCryptoError);
    });

    it('refuses a ciphertext with a flipped bit rather than returning damaged plaintext', async () => {
        const sealed = await sealPaymentHandles(PLAINTEXT, [recipientOf(anna)], GUILD, OWNER);
        const bytes = fromBase64(sealed.ciphertext);
        bytes[0] ^= 0x01;

        await expect(openPaymentHandles(
            {...sealed, ciphertext: toBase64(bytes)},
            sealed.wraps[0].wrappedKey, anna.privateKey, anna.deviceId, GUILD, OWNER),
        ).rejects.toThrow(PaymentCryptoError);
    });

    it('refuses a truncated wrap', async () => {
        const sealed = await sealPaymentHandles(PLAINTEXT, [recipientOf(anna)], GUILD, OWNER);
        const truncated = toBase64(fromBase64(sealed.wraps[0].wrappedKey).subarray(0, 40));

        await expect(openPaymentHandles(
            sealed, truncated, anna.privateKey, anna.deviceId, GUILD, OWNER),
        ).rejects.toThrow(/not in a form this build can open/);
    });

    it('reports an envelope version it does not know as exactly that', async () => {
        // Distinguished from a corrupt blob on purpose: "written by a newer version of the app" is
        // something the user can act on, and implying tampering there would be wrong.
        const sealed = await sealPaymentHandles(PLAINTEXT, [recipientOf(anna)], GUILD, OWNER);

        await expect(openPaymentHandles(
            {...sealed, version: 99}, sealed.wraps[0].wrappedKey, anna.privateKey, anna.deviceId,
            GUILD, OWNER),
        ).rejects.toThrow(/version 99/);
    });

    it('refuses a private key that is not a 32-byte Ed25519 seed', async () => {
        const sealed = await sealPaymentHandles(PLAINTEXT, [recipientOf(anna)], GUILD, OWNER);

        await expect(openPaymentHandles(
            sealed, sealed.wraps[0].wrappedKey, toBase64(new Uint8Array(64)), anna.deviceId,
            GUILD, OWNER),
        ).rejects.toThrow(/32-byte Ed25519 seed/);
    });
});

describe('sealPaymentHandles - refusing a key it cannot use', () => {
    it('throws rather than skipping a device with a wrong-length key', async () => {
        // Never silently skipped. A user who believes they sealed to Ben's two phones and reached
        // one has a worse problem than a user who was told the write did not happen.
        await expect(sealPaymentHandles(PLAINTEXT, [{
            userId: 'user_ben', deviceId: 'dev_ben_phone', publicKey: toBase64(new Uint8Array(16)),
        }], GUILD, OWNER)).rejects.toThrow(/not an Ed25519 public key/);
    });

    it('names the device in the failure, so the user is told which person is affected', async () => {
        await expect(sealPaymentHandles(PLAINTEXT, [{
            userId: 'user_ben', deviceId: 'dev_ben_tablet', publicKey: 'not base64 at all!!',
        }], GUILD, OWNER)).rejects.toThrow(/dev_ben_tablet/);
    });

    it('refuses an all-zero key, which agrees to a degenerate secret', async () => {
        await expect(sealPaymentHandles(PLAINTEXT, [{
            userId: 'user_ben', deviceId: 'dev_ben_phone', publicKey: toBase64(new Uint8Array(32)),
        }], GUILD, OWNER)).rejects.toThrow(PaymentCryptoError);
    });
});
