/**
 * "Who's home" - the household's answer to *are you in the flat*, which is a different
 * question from whether your client holds a socket.
 *
 * <p>Deliberately kept away from {@link import('./profile.dto').OnlineStatus}: that one means
 * "their app is connected" and is derived from the connection, this one is asserted by a person
 * and expires. Merging them into one dot would make both unreadable.</p>
 */
export enum HomeStatusKind {
    Home = 'Home',
    Out = 'Out',
    Asleep = 'Asleep',
    DoNotDisturb = 'DoNotDisturb',
    OnMyWay = 'OnMyWay',
}

/**
 * Declaration order of `Guild.Domain.Enums.HomeStatusKind`.
 *
 * <p>The AsyncAPI schema says of `kind`: *"int when serialised by a host without
 * JsonStringEnumConverter (see the gateway)"*. So the same field arrives as `"Asleep"` over REST
 * and can arrive as `2` over the hub. Indexed rather than cast, for the same reason the inbox
 * indexes its message types - a cast would silently produce a kind that is not in the enum and
 * every `switch` downstream would fall through to the default.</p>
 */
export const HOME_STATUS_KINDS: readonly HomeStatusKind[] = [
    HomeStatusKind.Home,
    HomeStatusKind.Out,
    HomeStatusKind.Asleep,
    HomeStatusKind.DoNotDisturb,
    HomeStatusKind.OnMyWay,
];

export interface HomeStatusDto {
    userId: string;
    kind: HomeStatusKind;
    /** ≤100 chars. */
    note: string | null;
    /**
     * Authoritative. `GET` never returns an entry past this instant and a member with no live
     * status is simply absent from the array - there is no "cleared" row to read.
     */
    expiresAt: string;
}

/** `PUT` body. Omitting `expiresInMinutes` means 12 hours; the server caps it at 7 days. */
export interface SetHomeStatusDto {
    kind: HomeStatusKind;
    note?: string | null;
    expiresInMinutes?: number;
}

/** 12 hours, the server's default when `expiresInMinutes` is omitted. */
export const HOME_STATUS_DEFAULT_MINUTES = 12 * 60;

/** 7 days. Anything longer is rejected. */
export const HOME_STATUS_MAX_MINUTES = 7 * 24 * 60;

export const HOME_STATUS_NOTE_MAX = 100;

/**
 * `guild.HomeStatusChanged` carries **two different payload shapes under one event name** - the
 * set/refresh at `HouseholdGuildEndpoint.cs:61` and the clear at `:80`. Discriminated structurally
 * (`status` present vs. absent) because neither shape carries a type tag.
 */
export type HomeStatusChanged = HomeStatusSet | HomeStatusCleared;

export interface HomeStatusSet {
    guildId: string;
    /** `kind` may be the int form here; run it through `normalizeHomeStatus`. */
    status: HomeStatusDto;
}

export interface HomeStatusCleared {
    guildId: string;
    userId: string;
    cleared: boolean;
}

export function isHomeStatusSet(event: HomeStatusChanged): event is HomeStatusSet {
    return (event as HomeStatusSet).status != null;
}

/**
 * One wire status into the shape the store keeps.
 *
 * <p>Returns `null` for a payload with no `userId` or no `expiresAt`: an entry with no expiry
 * could never decay, which is the one failure mode this whole feature exists to avoid.</p>
 */
export function normalizeHomeStatus(raw: unknown): HomeStatusDto | null {
    if (!raw || typeof raw !== 'object') return null;
    const s = raw as Record<string, unknown>;
    const userId = typeof s['userId'] === 'string' ? s['userId'] : null;
    const expiresAt = typeof s['expiresAt'] === 'string' ? s['expiresAt'] : null;
    if (!userId || !expiresAt || Number.isNaN(Date.parse(expiresAt))) return null;

    const kind = normalizeHomeStatusKind(s['kind']);
    if (!kind) return null;

    const note = typeof s['note'] === 'string' ? s['note'] : null;
    return {userId, kind, note, expiresAt};
}

/** Accepts both the string and the int serialisation; anything else is unknown, not `Home`. */
export function normalizeHomeStatusKind(raw: unknown): HomeStatusKind | null {
    if (typeof raw === 'number') return HOME_STATUS_KINDS[raw] ?? null;
    if (typeof raw !== 'string') return null;
    // A numeric string is the int form that went through a lenient serializer.
    if (/^\d+$/.test(raw)) return HOME_STATUS_KINDS[Number(raw)] ?? null;
    return HOME_STATUS_KINDS.find(k => k === raw) ?? null;
}
