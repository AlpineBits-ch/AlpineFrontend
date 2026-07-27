export interface InvokeBotCommandOptionDto {
    name: string;
    value: string | number | boolean;
}

export interface InvokeBotCommandDto {
    botUserId: string;
    commandName: string;
    options: InvokeBotCommandOptionDto[];
}
