export enum MessageType {
    Message = 'Message',
    System = 'System',
    Invite = 'Invite',
    GuildMemberJoin = 'GuildMemberJoin',
    GuildMemberLeave = 'GuildMemberLeave',

    /**
     * A call in this conversation finished, having been answered. `content` is the call's
     * duration in whole seconds as plain text - there is no variant copy to pick from, so
     * `systemMessageVariant` is null on these.
     */
    CallEnded = 'CallEnded',

    /** A call that ended with nobody but the caller ever connecting. `content` is empty. */
    CallMissed = 'CallMissed',

    /**
     * Somebody asked you into a voice channel - the durable half of a voice ring, written by the
     * server into the 1:1 conversation between the two.
     *
     * <p><b>Not a system message, deliberately.</b> Unlike a join notice or a call entry, this is
     * addressed by one person to another and carries a card you can act on, so it renders as an
     * ordinary message from the inviter rather than as centred grey copy. See
     * {@link isSystemMessageType}.</p>
     *
     * <p>Everything renderable is in the message's single `venta.voice_invite` embed. `content` is a
     * plain-English fallback for consumers that do not understand this type, and the message
     * component suppresses it so it is not shown twice.</p>
     */
    VoiceChannelInvite = 'VoiceChannelInvite',
}
