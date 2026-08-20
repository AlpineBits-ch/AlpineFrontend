export enum MessageType {
    Message = 'Message',
    System = 'System',
    Invite = 'Invite',
    GuildMemberJoin = 'GuildMemberJoin',
    GuildMemberLeave = 'GuildMemberLeave',

    /** A call in this conversation finished, having been answered. `content` is its duration in whole seconds. */
    CallEnded = 'CallEnded',

    /** A call that ended with nobody but the caller ever connecting. `content` is empty. */
    CallMissed = 'CallMissed',

    /**
     * Somebody asked you into a voice channel, the durable half of a voice ring.
     * Not a system message: it renders as an ordinary message from the inviter.
     */
    VoiceChannelInvite = 'VoiceChannelInvite',

    /** A group was renamed. `content` is the new name, empty when it was cleared. */
    GroupNameChanged = 'GroupNameChanged',

    /** A group's icon changed. `content` is empty, or `removed` when the icon was deleted. */
    GroupIconChanged = 'GroupIconChanged',

    /**
     * A server-rolled result. `content` is the plain line and `embedsJson` carries the structured
     * roll; a client that reads neither still shows the text.
     */
    DiceRoll = 'DiceRoll',

    /**
     * A character walked into a scene. Carries the character on `personaId` and its display fields,
     * so a rename later does not rewrite what the log said at the time.
     */
    SceneCharacterJoined = 'SceneCharacterJoined',

    /** A character left a scene. `content` is `removed` when a game master took them out. */
    SceneCharacterLeft = 'SceneCharacterLeft',
}
