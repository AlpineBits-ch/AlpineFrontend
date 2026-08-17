export interface BotCommandOptionDto {
    name: string;
    description: string;
    /** Discord's numeric option type - see DiscordOptionType. */
    type: number;
    required: boolean;
}

export interface BotCommandDto {
    botUserId: string;
    botName: string;
    name: string;
    description: string;
    options: BotCommandOptionDto[];
    /** Informational only - unrelated to CommandDef.scope in the composer's local commands. */
    scope: 'global' | 'guild';
}
