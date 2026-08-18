export interface RollDiceDto {
    expression: string;
    /** The character rolling. Null falls through to the channel's autoproxy, same as sending. */
    personaId?: string | null;
    /** What the roll is for. Becomes the roll's title. */
    reason?: string | null;
}
