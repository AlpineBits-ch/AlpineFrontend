export enum DiscordOptionType {
    String = 3,
    Integer = 4,
    Boolean = 5,
    User = 6,
    Channel = 7,
    Role = 8,
    Mentionable = 9,
    Number = 10,
}

export function discordOptionInputKind(type: number): 'text' | 'number' | 'boolean' {
    if (type === DiscordOptionType.Boolean) return 'boolean';
    if (type === DiscordOptionType.Integer || type === DiscordOptionType.Number) return 'number';
    return 'text';
}

export function discordOptionPlaceholder(type: number): string {
    switch (type) {
        case DiscordOptionType.User: return 'User ID';
        case DiscordOptionType.Channel: return 'Channel ID';
        case DiscordOptionType.Role: return 'Role ID';
        case DiscordOptionType.Mentionable: return 'User or Role ID';
        default: return '';
    }
}

export function discordOptionTypeLabel(type: number): string {
    switch (type) {
        case DiscordOptionType.String: return 'text';
        case DiscordOptionType.Integer: return 'integer';
        case DiscordOptionType.Boolean: return 'boolean';
        case DiscordOptionType.User: return 'user';
        case DiscordOptionType.Channel: return 'channel';
        case DiscordOptionType.Role: return 'role';
        case DiscordOptionType.Mentionable: return 'mentionable';
        case DiscordOptionType.Number: return 'number';
        default: return 'value';
    }
}
