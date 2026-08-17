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
}
