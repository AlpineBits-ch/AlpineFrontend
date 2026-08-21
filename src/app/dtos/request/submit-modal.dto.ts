import {BotComponentPayload} from '../bot-component.dto';

/**
 * The answer to a `guild.ModalOpen`, as
 * `POST /bots/guilds/{guildId}/channels/{channelId}/modal-submit` wants it.
 *
 * <p>`botUserId` and `customId` are echoed back from the event that opened the modal - the server
 * has no other way to tell which bot, or which of its flows, this reply belongs to.</p>
 */
export interface SubmitModalDto {
    botUserId: string;
    customId: string;

    /**
     * Discord's modal-submit shape: one action row per field, each wrapping the single text input
     * it holds, with `value` filled in. Not a flat list of inputs - the server hands these to the
     * bot's library verbatim, and discord.js reads answers through `components[i].components[0]`.
     */
    components: BotComponentPayload[];
}
