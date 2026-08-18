/** One term of an expression: a pool of dice, or a bare constant. */
export interface DiceTermDto {
    /** The term as the server normalised it, e.g. `4d6kh3`. */
    notation: string;
    /** 1 or -1. A subtracted term still shows its dice as rolled. */
    sign: number;
    /** Set instead of `dice` when the term is a constant. */
    constant?: number | null;
    /** Every die in the term, explosions already folded into the die that caused them. */
    dice: number[];
    /** The subset that counted. A die in `dice` but not here was dropped. */
    kept: number[];
    subtotal: number;
}

export interface DiceRollDto {
    id: string;
    messageId: string;
    channelId: string;
    rollerUserId: string;
    personaId?: string | null;
    /** The server's normalisation, not what was typed. Render this. */
    expression: string;
    reason?: string | null;
    total: number;
    visibility: 'Public';
    /** Plain text, with a dropped die marked `~1`. The fallback when `terms` cannot be read. */
    breakdown: string;
    terms: DiceTermDto[];
    createdAt: string;
}

/**
 * The `dice` member the server hangs off the roll's embed. Same shape as the roll minus the
 * identifiers, so a client that already renders embeds ignores it and one that knows dice reads it.
 */
export interface DiceEmbedPayload {
    expression: string;
    total: number;
    breakdown: string;
    terms: DiceTermDto[];
    reason?: string | null;
}

/**
 * `guild.DiceRolled`, to whoever can see the channel. No terms: the roll's message carries the
 * faces, and `rollerUserId` is withheld for a roll made in character.
 */
export interface DiceRolledDto {
    guildId: string;
    channelId: string;
    rollId: string;
    messageId: string;
    rollerUserId?: string | null;
    personaId?: string | null;
    expression: string;
    total: number;
    breakdown: string;
    reason?: string | null;
    visibility: 'Public';
    createdAt: string;
}
