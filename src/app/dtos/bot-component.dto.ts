/** Discord's component type tags, as `ComponentPayload.Type` carries them. */
export const BotComponentType = {
    ActionRow: 1,
    Button: 2,
    StringSelect: 3,
    TextInput: 4,
    UserSelect: 5,
    RoleSelect: 6,
    MentionableSelect: 7,
    ChannelSelect: 8,
} as const;

/**
 * One node of a bot-authored component tree, in Discord's own wire shape.
 *
 * The snake_case names are correct and the published contract disagrees with them. The AsyncAPI
 * generator drops every member carrying a `[JsonIgnore]` attribute, which on the server's
 * `ComponentPayload` is all of them but `Type`, and renders whatever survives through a camelCase
 * policy, ignoring `[JsonPropertyName]`. So the contract advertises `{type}` alone while the socket
 * delivers `custom_id`, `min_length` and `max_length`. Reading `customId` off one of these finds
 * `undefined` every time.
 *
 * One type for both directions: the modal-submit endpoint deserializes the rows the client posts
 * back with the same `ComponentPayload` class that produced them.
 */
export interface BotComponentPayload {
    /** One of {@link BotComponentType}. */
    type: number;
    /** Set only on an action row, which is the sole container type. */
    components?: BotComponentPayload[] | null;
    /** The bot's own handle for this component, echoed back verbatim when the user answers. */
    custom_id?: string | null;
    label?: string | null;
    /** Button style 1-5; on a text input, 1 is single-line and 2 is a paragraph box. */
    style?: number | null;
    url?: string | null;
    disabled?: boolean | null;
    placeholder?: string | null;
    min_values?: number | null;
    max_values?: number | null;
    // Text input (modals only).
    value?: string | null;
    required?: boolean | null;
    min_length?: number | null;
    max_length?: number | null;
}

/**
 * `guild.ModalOpen`, a bot asking this client to put a form on screen.
 *
 * `customId` is the bot's correlation handle for the answer, and goes straight back out on
 * `POST /bots/guilds/{g}/channels/{c}/modal-submit`. `guildId` is nullable in the contract but the
 * submit route needs it in the path, so a modal that arrives without one cannot be answered.
 */
export interface WsBotModalOpen {
    guildId: string | null;
    channelId: string;
    botUserId: string;
    customId: string | null;
    title: string | null;
    components: BotComponentPayload[];
}
