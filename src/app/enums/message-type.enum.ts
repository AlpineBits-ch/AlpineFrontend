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
}
