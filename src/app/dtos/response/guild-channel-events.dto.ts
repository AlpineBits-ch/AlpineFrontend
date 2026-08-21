import {MlsJoinRequestEvent} from '../../services/messaging-websocket.service';

export interface ChannelTypingEvent {
    channelId: string;
    userId: string;
}

export interface WsChannelCreated {
    channelId: string;
    guildId: string;
}

export interface WsChannelDeleted {
    channelId: string;
    guildId: string;
}

export interface WsChannelUpdated {
    channelId: string;
    guildId: string;
}

/**
 * A channel's encryption was toggled. Clients must act on this: one that keeps encrypting after a
 * disable, or keeps sending plaintext after an enable, has its sends refused until it catches up.
 */
export interface WsChannelMlsStateChanged {
    channelId: string;
    guildId: string;
    encrypted: boolean;
    /** The generation now active, or the one just terminated. */
    generation: number;
    changedByUserId: string;
}

/**
 * A device is asking to be let into a channel's MLS group, the channel-side twin of
 * `conversation.MlsJoinRequest`.
 *
 * Thinner than its twin. The conversation push at least names the request, the requesting device
 * and the fingerprint a human is supposed to compare; this one carries three ids and nothing else.
 * Neither is enough to act on, so the review surface re-reads
 * `GET .../channels/{id}/mls/join-requests` either way, and that read is what the decision is made
 * against. The only thing this event has to get right is that something is waiting, and for which
 * channel.
 *
 * Every field the twin carries is declared optional rather than omitted: a server that starts
 * sending them should be believed rather than ignored.
 */
export interface WsChannelMlsJoinRequested {
    channelId: string;
    guildId: string;
    requesterUserId: string;
    requestId?: string;
    requesterDeviceId?: string;
    requesterDeviceName?: string | null;
    signatureKeyFingerprint?: string;
    generation?: number;
    /** The server's published verdict on whether a human must tap approve (§J.4). */
    requiresManualApproval?: boolean;
}

/**
 * Normalizes a channel join-request push, failing closed on the one field that is a policy call.
 *
 * Mirrors `toJoinRequestEvent`: `requiresManualApproval` absent means an older server, or a payload
 * that lost the field on the way here, and defaulting it to false would read as "this may be
 * admitted without anyone being asked". An unstated verdict is taken as "a human decides" (§J.4).
 *
 * The fields the channel push does not carry become empty rather than fabricated. They are
 * display-and-correlation only, so an empty fingerprint here can never be mistaken for a
 * fingerprint that matched.
 */
export function toChannelJoinRequestEvent(payload: WsChannelMlsJoinRequested): MlsJoinRequestEvent {
    return {
        contextId: payload.channelId,
        isChannel: true,
        generation: payload.generation ?? 0,
        requestId: payload.requestId ?? '',
        requesterUserId: payload.requesterUserId,
        requesterDeviceId: payload.requesterDeviceId ?? '',
        requesterDeviceName: payload.requesterDeviceName ?? null,
        signatureKeyFingerprint: payload.signatureKeyFingerprint ?? '',
        requiresManualApproval: payload.requiresManualApproval ?? true,
    };
}

export interface WsCategoryCreated {
    categoryId: string;
    guildId: string;
}

/**
 * A category was renamed or moved. The payload names it and nothing more, so the current row has
 * to be re-read, the same shape `guild.ChannelUpdated` has.
 */
export interface WsCategoryUpdated {
    categoryId: string;
    guildId: string;
}

export interface WsCategoryDeleted {
    categoryId: string;
    guildId: string;
}

export interface WsThreadCreated {
    channelId: string;
    parentChannelId: string;
    guildId: string;
    /** Forum posts only; absent for text-channel threads. */
    tagIds?: string[];
}

/**
 * Applied-tag changes, pins, locks, renames and archives all arrive here rather than as separate
 * events. The payload carries the full current state of those flags, so treat it as a replace, not
 * a patch.
 */
export interface WsThreadUpdated {
    channelId: string;
    parentChannelId: string;
    guildId: string;
    name?: string;
    tagIds?: string[];
    isPinned?: boolean;
    isLocked?: boolean;
    isArchived?: boolean;
}

/** Redraw the one message named here. Separate from ThreadCreated, which only says a thread exists. */
export interface WsMessageThreadAttached {
    channelId: string;
    guildId: string;
    messageId: string;
    threadId: string;
    name: string;
}
