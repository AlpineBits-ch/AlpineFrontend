/**
 * A codec for one .NET `[Flags]` enum on the wire.
 *
 * Two masks now arrive on a role - `permissions` and `modulePermissions` - with separate bit
 * numbering and overlapping values, so the parsing has to be parameterised by a table rather
 * than baked into one enum file.
 *
 * The part that earns its keep is {@link FlagCarrier}. A build only knows the flag names it
 * shipped with, so a mask from a newer server carries bits this client cannot name. Reading is
 * fine - you ignore what you don't understand - but an editor that parses, toggles one bit and
 * writes back would drop every unrecognised flag on the way out. The carrier keeps that residue
 * beside the value so a save puts it back.
 */

export type FlagTable = Readonly<Record<string, bigint>>;

/** Every shape .NET has been seen to serialize a `[Flags]` enum in. */
export type SerializedFlags = string | number | bigint | null | undefined;

/**
 * A parsed mask plus whatever this build could not account for.
 *
 * Names and bits are held apart because a payload is either a name list or a number, never both,
 * and they go back out differently: names re-emit verbatim, bare bits force the whole mask back
 * to its numeric form.
 */
export interface FlagCarrier {
    readonly value: bigint;
    readonly unknownNames: readonly string[];
    readonly unknownBits: bigint;
}

export const EMPTY_CARRIER: FlagCarrier = {value: 0n, unknownNames: [], unknownBits: 0n};

const NONE = 'None';
const NUMERIC = /^\d+n?$/;

export interface FlagCodec<K extends string> {
    readonly keys: readonly K[];
    readonly all: bigint;

    parse(serialized: SerializedFlags): bigint;

    parseCarrier(serialized: SerializedFlags): FlagCarrier;

    stringify(mask: bigint): string;

    stringifyCarrier(carrier: FlagCarrier): string;

    withValue(carrier: FlagCarrier, value: bigint): FlagCarrier;

    has(mask: bigint, flag: bigint): boolean;

    diff(requested: bigint, grantable: bigint): K[];

    label(key: K): string;
}

/** One labelled block of flags in a permission editor. */
export interface FlagGroup<K extends string> {
    /** Untranslated identifier - stable across locales, and the `@for` track. */
    label: string;
    /** The `PERM_GROUP.*` key the UI renders. */
    labelKey: string;
    perms: K[];
    /**
     * The `GuildFeatures` module gating this group. A plain string so this layer needs no
     * feature-layer import; the values are the flag names anyway. Absent means always shown.
     */
    feature?: string;
}

/** Everything a permission editor needs to render and edit one mask. */
export interface FlagCatalog<K extends string = string> {
    table: FlagTable;
    groups: readonly FlagGroup<K>[];
}

export function createFlagCodec<T extends FlagTable>(table: T): FlagCodec<Extract<keyof T, string>> {
    type K = Extract<keyof T, string>;

    // A zero entry ("None") matches every mask under `&`, so it never belongs in a name list.
    const keys = (Object.keys(table) as K[]).filter(key => table[key] !== 0n);
    const all = keys.reduce((acc, key) => acc | table[key], 0n);

    const parseCarrier = (serialized: SerializedFlags): FlagCarrier => {
        if (serialized === null || serialized === undefined || serialized === '') return EMPTY_CARRIER;

        const bits = numericValue(serialized);
        if (bits !== null) {
            return {value: bits & all, unknownNames: [], unknownBits: bits & ~all};
        }

        let value = 0n;
        const unknownNames: string[] = [];
        for (const part of String(serialized).split(',')) {
            const name = part.trim();
            if (!name || name === NONE) continue;
            const flag = table[name as K];
            if (flag === undefined) unknownNames.push(name);
            else value |= flag;
        }
        return {value, unknownNames, unknownBits: 0n};
    };

    const stringify = (mask: bigint): string => {
        const names = keys.filter(key => (mask & table[key]) === table[key]);
        return names.length ? names.join(', ') : NONE;
    };

    return {
        keys,
        all,
        parseCarrier,
        parse: serialized => parseCarrier(serialized).value,
        stringify,

        // Bits with no name cannot be expressed in a name list, so a residue of them drags the
        // whole mask back to the numeric form the server also accepts.
        stringifyCarrier: carrier => {
            if (carrier.unknownBits !== 0n) return (carrier.value | carrier.unknownBits).toString();
            const known = keys.filter(key => (carrier.value & table[key]) === table[key]);
            const names = [...known, ...carrier.unknownNames];
            return names.length ? names.join(', ') : NONE;
        },

        withValue: (carrier, value) => ({...carrier, value}),

        has: (mask, flag) => (mask & flag) === flag,

        diff: (requested, grantable) => keys.filter(
            key => (requested & table[key]) === table[key] && (grantable & table[key]) !== table[key],
        ),

        label: key => key.replace(/([A-Z])/g, ' $1').trim(),
    };
}

/**
 * The mask as a number, or null when it is a name list.
 *
 * A JSON number cannot carry bit 63 - `Superadmin` sits there - so a numeric payload with high
 * bits set is already rounded by the time `JSON.parse` hands it over. Nothing recoverable here;
 * the server has to send names for those.
 */
function numericValue(serialized: SerializedFlags): bigint | null {
    if (typeof serialized === 'bigint') return serialized;
    if (typeof serialized === 'number') return Number.isInteger(serialized) ? BigInt(serialized) : 0n;
    if (typeof serialized === 'string' && NUMERIC.test(serialized)) return BigInt(serialized.replace('n', ''));
    return null;
}
