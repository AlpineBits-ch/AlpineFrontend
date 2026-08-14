import {describe, expect, it} from 'vitest';
import {createFlagCodec} from './flag-mask';

const codec = createFlagCodec({
    None: 0n,
    Read: 1n << 0n,
    Write: 1n << 1n,
    Admin: 1n << 63n,
});

describe('createFlagCodec', () => {
    it('parses a comma-separated name list', () => {
        expect(codec.parse('Read, Write')).toBe(codec.all & ~(1n << 63n));
    });

    it('parses a numeric mask', () => {
        expect(codec.parse('3')).toBe(3n);
        expect(codec.parse(3)).toBe(3n);
        expect(codec.parse(3n)).toBe(3n);
    });

    it('treats None and empty alike as no flags', () => {
        expect(codec.parse('None')).toBe(0n);
        expect(codec.parse('')).toBe(0n);
        expect(codec.parse(null)).toBe(0n);
    });

    it('never emits the zero entry as a name', () => {
        expect(codec.keys).not.toContain('None');
        expect(codec.stringify(codec.parse('Read'))).toBe('Read');
    });

    it('stringifies an empty mask as None', () => {
        expect(codec.stringify(0n)).toBe('None');
    });

    it('survives bit 63, which a JSON number cannot carry', () => {
        expect(codec.parse('Admin')).toBe(1n << 63n);
        expect(codec.stringify(1n << 63n)).toBe('Admin');
    });
});

// The failure this whole carrier exists to prevent: a client that predates a flag must not strip
// it by opening a role and pressing Save.
describe('FlagCarrier round trips', () => {
    it('re-emits a name it has no bit for', () => {
        const carrier = codec.parseCarrier('Read, Teleport');

        expect(carrier.value).toBe(1n << 0n);
        expect(carrier.unknownNames).toEqual(['Teleport']);
        expect(codec.stringifyCarrier(carrier)).toBe('Read, Teleport');
    });

    it('keeps the unknown name when the known bits are edited', () => {
        const carrier = codec.parseCarrier('Read, Teleport');
        const edited = codec.withValue(carrier, carrier.value | (1n << 1n));

        expect(codec.stringifyCarrier(edited)).toBe('Read, Write, Teleport');
    });

    it('keeps the unknown name when every known bit is cleared', () => {
        const carrier = codec.parseCarrier('Read, Teleport');

        expect(codec.stringifyCarrier(codec.withValue(carrier, 0n))).toBe('Teleport');
    });

    it('falls back to a number when the residue is bits rather than names', () => {
        const carrier = codec.parseCarrier((1n << 0n) | (1n << 40n));

        expect(carrier.value).toBe(1n << 0n);
        expect(carrier.unknownBits).toBe(1n << 40n);
        expect(codec.stringifyCarrier(carrier)).toBe(((1n << 0n) | (1n << 40n)).toString());
    });

    it('preserves unnameable bits across an edit', () => {
        const carrier = codec.parseCarrier((1n << 40n).toString());
        const edited = codec.withValue(carrier, 1n << 1n);

        expect(codec.stringifyCarrier(edited)).toBe(((1n << 1n) | (1n << 40n)).toString());
    });

    it('stringifies an empty carrier as None', () => {
        expect(codec.stringifyCarrier(codec.parseCarrier(null))).toBe('None');
    });
});

describe('has and diff', () => {
    it('requires every bit of a compound flag', () => {
        const both = (1n << 0n) | (1n << 1n);

        expect(codec.has(both, 1n << 0n)).toBe(true);
        expect(codec.has(1n << 0n, both)).toBe(false);
    });

    it('names the flags requested but not grantable', () => {
        expect(codec.diff((1n << 0n) | (1n << 1n), 1n << 0n)).toEqual(['Write']);
    });
});

describe('label', () => {
    it('splits a camel-case key into words', () => {
        expect(codec.label('Read')).toBe('Read');
        expect(createFlagCodec({ReadMessageHistory: 1n}).label('ReadMessageHistory')).toBe('Read Message History');
    });
});
