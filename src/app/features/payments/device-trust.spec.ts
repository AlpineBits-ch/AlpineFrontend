import {describe, expect, it} from 'vitest';
import {ed25519} from '@noble/curves/ed25519.js';
import {
    classifyRecipient,
    DevicePins,
    fingerprintOf,
    formatFingerprint,
    pinsAfterSeal,
    planSeal,
    RecipientAttestation,
    RecipientTrust,
} from './device-trust';
import {toBase64} from './payment-handle-crypto';

function key(): string {
    return toBase64(ed25519.getPublicKey(ed25519.utils.randomSecretKey()));
}

function attestation(overrides: Partial<RecipientAttestation> = {}): RecipientAttestation {
    return {
        userId: 'user_ben',
        deviceId: 'dev_ben_phone',
        deviceName: "Ben's phone",
        publicKey: key(),
        hasValidCertificate: true,
        certificate: 'Y2VydA==',
        certificateRevokedAt: null,
        isActive: true,
        ...overrides,
    };
}

/** A pin in the stored shape, so a test never has to spell the record out. */
function pin(publicKey: string, identityKeyVersion?: number): DevicePins {
    return {dev_ben_phone: {publicKey, ...(identityKeyVersion === undefined ? {} : {identityKeyVersion})}};
}

async function classify(
    a: RecipientAttestation,
    pins: DevicePins = {},
    previous: string | null = null,
    now = new Date('2026-08-07T12:00:00Z'),
): Promise<RecipientTrust> {
    return classifyRecipient(a, await fingerprintOf(a.publicKey), pins, previous, now);
}

describe('fingerprintOf', () => {
    it('renders eighty bits as upper-case hex in five-character groups', async () => {
        const fingerprint = await fingerprintOf(key());
        // Four groups of five, then a final group of nothing left over: twenty hex characters.
        expect(fingerprint).toMatch(/^[0-9A-F]{5}(-[0-9A-F]{5}){3}$/);
    });

    it('matches the Rust engine byte for byte, which is what makes an out-of-band compare work', () => {
        // `format_fingerprint` is SHA-256 of the key, first ten bytes, upper-case hex, grouped in
        // fives. The value shown next to a housemate's device has to be the same string that
        // device shows for itself and that the MLS join-request review prints, or a user comparing
        // them is comparing two unrelated things and will learn to ignore a mismatch.
        const digest = Uint8Array.from([
            0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc, 0xba, 0x98,
        ]);
        expect(formatFingerprint(digest)).toBe('01234-56789-ABCDE-FFEDC');
    });

    it('is stable for one key and different across keys', async () => {
        const k = key();
        expect(await fingerprintOf(k)).toBe(await fingerprintOf(k));
        expect(await fingerprintOf(k)).not.toBe(await fingerprintOf(key()));
    });

    it('returns nothing for a key that is not thirty-two bytes', async () => {
        // A real-looking fingerprint over a malformed key would invite somebody to compare a string
        // for a device nothing can ever be sealed to.
        expect(await fingerprintOf(toBase64(new Uint8Array(16)))).toBe('');
        expect(await fingerprintOf('not base64 at all!!')).toBe('');
    });
});

describe('classifyRecipient', () => {
    it('trusts a certificated, active, first-seen device without a prompt', async () => {
        const trust = await classify(attestation());
        expect(trust.level).toBe('attested');
        expect(trust.firstSeen).toBe(true);
        expect(trust.needsConfirmation).toBe(false);
    });

    it('trusts a certificated device whose pinned key still matches', async () => {
        const a = attestation();
        const trust = await classify(a, pin(a.publicKey));
        expect(trust.level).toBe('attested');
        expect(trust.firstSeen).toBe(false);
    });

    it('flags a device with no valid certificate rather than sealing to it silently', async () => {
        const trust = await classify(attestation({hasValidCertificate: false}));
        expect(trust.level).toBe('unattested');
        expect(trust.needsConfirmation).toBe(true);
    });

    it('flags a revoked certificate separately from a missing one', async () => {
        // "Never had a certificate" and "had one and it was pulled" are different facts, and the
        // second is the one worth being alarmed by.
        const trust = await classify(attestation({certificateRevokedAt: '2026-08-01T10:00:00Z'}));
        expect(trust.level).toBe('revoked');
    });

    it('flags a device its owner has marked removed', async () => {
        expect((await classify(attestation({isActive: false}))).level).toBe('inactive');
    });

    it('flags an unusable key rather than pretending it is merely unattested', async () => {
        const trust = await classify(attestation({publicKey: toBase64(new Uint8Array(16))}));
        expect(trust.level).toBe('unusable');
        expect(trust.fingerprint).toBe('');
    });

    /**
     * The check that actually catches directory substitution, and the only one that needs no
     * cooperation from the server. It is deliberately ranked above the certificate flags: a server
     * able to substitute a key is a server able to mint a certificate for it, so a valid
     * certificate on a changed key is what the attack looks like, not a reason to relax.
     */
    it('raises a changed key above every other state, valid certificate or not', async () => {
        const a = attestation();
        const previously = key();

        const trust = await classify(a, pin(previously), 'AAAAA-BBBBB-CCCCC-DDDDD');

        expect(trust.level).toBe('key-changed');
        expect(trust.needsConfirmation).toBe(true);
        expect(trust.previousFingerprint).toBe('AAAAA-BBBBB-CCCCC-DDDDD');
    });

    it('carries no previous fingerprint when the key did not change', async () => {
        const a = attestation();
        const trust = await classify(a, pin(a.publicKey), 'AAAAA-BBBBB-CCCCC-DDDDD');
        expect(trust.previousFingerprint).toBeNull();
    });
});

describe('planSeal', () => {
    it('includes trusted devices and holds back the rest', async () => {
        const good = await classify(attestation({deviceId: 'dev_good'}));
        const unattested = await classify(
            attestation({deviceId: 'dev_unattested', hasValidCertificate: false}),
        );

        const plan = planSeal([good, unattested], new Set(), []);

        expect(plan.included.map(t => t.attestation.deviceId)).toEqual(['dev_good']);
        expect(plan.blocked.map(t => t.attestation.deviceId)).toEqual(['dev_unattested']);
    });

    it('includes a flagged device once the user has confirmed that specific device', async () => {
        const unattested = await classify(
            attestation({deviceId: 'dev_unattested', hasValidCertificate: false}),
        );

        const plan = planSeal([unattested], new Set(['dev_unattested']), []);
        expect(plan.included).toHaveLength(1);
        expect(plan.blocked).toHaveLength(0);
    });

    it('never includes an unusable key, even confirmed', async () => {
        // Agreeing to it would produce a wrap that cannot exist, not a risk the user accepted.
        const unusable = await classify(
            attestation({deviceId: 'dev_broken', publicKey: toBase64(new Uint8Array(16))}),
        );

        const plan = planSeal([unusable], new Set(['dev_broken']), []);
        expect(plan.included).toHaveLength(0);
        expect(plan.blocked).toHaveLength(1);
    });

    it('carries unresolved members through rather than swallowing them', async () => {
        // A truncated roster silently leaves those people unable to read the blob, and this is the
        // only signal that says the recipient list was short.
        const plan = planSeal([], new Set(), ['user_carla']);
        expect(plan.unresolvedMemberIds).toEqual(['user_carla']);
    });
});

describe('pinsAfterSeal', () => {
    it('pins every device actually written to and leaves the blocked ones unpinned', async () => {
        const good = await classify(attestation({deviceId: 'dev_good'}));
        const blocked = await classify(attestation({deviceId: 'dev_blocked', hasValidCertificate: false}));

        const plan = planSeal([good, blocked], new Set(), []);
        const pins = pinsAfterSeal(plan, {});

        expect(pins['dev_good']?.publicKey).toBe(good.attestation.publicKey);
        // Pinning a device we declined to seal to would quietly accept a key we refused.
        expect(pins['dev_blocked']).toBeUndefined();
    });

    it('overwrites a pin only for a device the user confirmed through the change', async () => {
        const a = attestation({deviceId: 'dev_ben_phone'});
        const previous = key();
        const changed = await classify(a, pin(previous), 'OLD');

        const declined = pinsAfterSeal(planSeal([changed], new Set(), []), pin(previous));
        expect(declined[a.deviceId]?.publicKey).toBe(previous);

        const accepted = pinsAfterSeal(planSeal([changed], new Set([a.deviceId]), []), pin(previous));
        expect(accepted[a.deviceId]?.publicKey).toBe(a.publicKey);
    });

    it('keeps pins for devices that were not in this seal', () => {
        const pins = pinsAfterSeal(
            {included: [], blocked: [], unresolvedMemberIds: []},
            {dev_old: {publicKey: 'key'}},
        );
        expect(pins['dev_old']?.publicKey).toBe('key');
    });
});

/**
 * The certificate bytes now arrive from the recipients endpoint, and **nothing verifies them** -
 * Alpine has no certificate verifier, because the Rust engine deliberately leaves the contract's
 * device-certificate section unimplemented. What having them does buy is the ability to catch the
 * server contradicting its own evidence, which was impossible while the evidence was withheld.
 * These are consistency checks, emphatically not attestation.
 */
describe('classifyRecipient - the server checked against itself', () => {
    const NOW = new Date('2026-08-07T12:00:00Z');

    it('flags a device described as certified with no certificate supplied', async () => {
        // Before the bytes were forwarded this was indistinguishable from an honest answer.
        const trust = await classify(
            attestation({hasValidCertificate: true, certificate: null}),
            {},
            null,
            NOW,
        );

        expect(trust.level).toBe('attestation-inconsistent');
        expect(trust.inconsistencies).toContain('certificate-missing');
        expect(trust.needsConfirmation).toBe(true);
    });

    it('flags a certificate whose own expiry has already passed', async () => {
        const trust = await classify(
            attestation({
                certificateExpiresAt: '2026-08-01T00:00:00Z',
            }),
            {},
            null,
            NOW,
        );

        expect(trust.inconsistencies).toContain('certificate-expired');
    });

    it('accepts a certificate that has not expired yet', async () => {
        const trust = await classify(
            attestation({
                certificateIssuedAt: '2026-01-01T00:00:00Z',
                certificateExpiresAt: '2027-01-01T00:00:00Z',
            }),
            {},
            null,
            NOW,
        );

        expect(trust.level).toBe('attested');
        expect(trust.inconsistencies).toEqual([]);
    });

    it('flags a certificate issued after it expires', async () => {
        const trust = await classify(
            attestation({
                certificateIssuedAt: '2027-01-01T00:00:00Z',
                certificateExpiresAt: '2026-01-01T00:00:00Z',
            }),
            {},
            null,
            NOW,
        );

        expect(trust.inconsistencies).toContain('certificate-dates-reversed');
    });

    it('says nothing about dates on a device that never claimed a certificate', async () => {
        // An uncertificated device is `unattested`, which is an ordinary state. Piling consistency
        // complaints on top of it would make the honest common case read like an attack.
        const trust = await classify(
            attestation({
                hasValidCertificate: false,
                certificate: null,
                certificateExpiresAt: '2020-01-01T00:00:00Z',
            }),
            {},
            null,
            NOW,
        );

        expect(trust.level).toBe('unattested');
        expect(trust.inconsistencies).toEqual([]);
    });

    it('ignores an unparseable date rather than calling it a contradiction', async () => {
        const trust = await classify(attestation({certificateExpiresAt: 'not a date'}), {}, null, NOW);
        expect(trust.inconsistencies).toEqual([]);
    });

    it('flags an identity key version that went backwards, which no rotation does', async () => {
        const a = attestation({identityKeyVersion: 2});
        const trust = await classify(a, pin(a.publicKey, 5), null, NOW);

        expect(trust.inconsistencies).toContain('identity-key-version-regressed');
        expect(trust.level).toBe('attestation-inconsistent');
    });

    it('flags a version that moved forward more gently, since a reset does that', async () => {
        const a = attestation({identityKeyVersion: 6});
        const trust = await classify(a, pin(a.publicKey, 5), null, NOW);

        expect(trust.inconsistencies).toEqual(['identity-key-version-changed']);
    });

    it('says nothing when the version is unchanged', async () => {
        const a = attestation({identityKeyVersion: 5});
        expect((await classify(a, pin(a.publicKey, 5), null, NOW)).inconsistencies).toEqual([]);
    });

    it('says nothing when there is no pinned version to compare against', async () => {
        // A pin taken before the endpoint reported versions has none. Treating that absence as a
        // change would re-prompt about every device somebody has already vouched for.
        const a = attestation({identityKeyVersion: 5});
        expect((await classify(a, pin(a.publicKey), null, NOW)).inconsistencies).toEqual([]);
    });

    it('keeps a changed key as the headline even when the certificate is impeccable', async () => {
        // A server able to substitute a key is a server able to mint a certificate for it, so a
        // clean certificate on a moved key is what the attack looks like, not a reason to relax.
        const a = attestation({
            certificateIssuedAt: '2026-01-01T00:00:00Z',
            certificateExpiresAt: '2027-01-01T00:00:00Z',
        });
        const trust = await classify(a, pin(key(), 1), 'OLD', NOW);

        expect(trust.level).toBe('key-changed');
    });
});

describe('pinsAfterSeal - the identity key version', () => {
    it('records the version alongside the key', async () => {
        const trust = await classify(attestation({deviceId: 'dev_a', identityKeyVersion: 4}));
        const pins = pinsAfterSeal(planSeal([trust], new Set(), []), {});

        expect(pins['dev_a']).toEqual({publicKey: trust.attestation.publicKey, identityKeyVersion: 4});
    });

    it('omits the version when the server reported none', async () => {
        // Writing `undefined` would clear a value a later comparison depends on, which is exactly
        // how a directory that stops sending the field would silence the check.
        const trust = await classify(attestation({deviceId: 'dev_a'}));
        const pins = pinsAfterSeal(planSeal([trust], new Set(), []), {});

        expect(pins['dev_a']).toEqual({publicKey: trust.attestation.publicKey});
    });
});
