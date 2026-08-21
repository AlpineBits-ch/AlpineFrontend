import {ReorderChannesDto} from '../dtos/request/reorder-channel.dto';
import {ReorderRolesDto} from '../dtos/request/reorder-roles.dto';
import {WsBotModalOpen} from '../dtos/bot-component.dto';
import {DiceRolledDto} from '../dtos/response/dice.dto';
import {GuildDto} from '../dtos/response/guild.dto';
import {ShareViewersDto} from '../dtos/response/share-viewers.dto';
import {WsVoiceRing, WsVoiceRingDismissed, WsVoiceRingResolved} from '../dtos/response/voice-ring.dto';
import {VoiceRoomSnapshot} from '../models/voice-room';
import {
    SceneConcludedDto,
    SceneCreatedDto,
    SceneJoinRequestedDto,
    SceneJoinRequestResolvedDto,
    SceneTagsChangedDto,
    SceneTaxonomyDto,
    SceneTurnChangedDto,
    SceneTurnNudgeDto,
    SceneUpdatedDto,
} from '../dtos/response/scene.dto';
import {
    ChannelTypingEvent,
    WsCategoryCreated,
    WsCategoryDeleted,
    WsCategoryUpdated,
    WsChannelCreated,
    WsChannelDeleted,
    WsChannelMlsJoinRequested,
    WsChannelMlsStateChanged,
    WsChannelUpdated,
    WsMessageThreadAttached,
    WsThreadCreated,
    WsThreadUpdated,
} from '../dtos/response/guild-channel-events.dto';
import {
    WsBotInstalled,
    WsBotUninstalled,
    WsEmojiCreated,
    WsEmojiDeleted,
    WsEventCancelled,
    WsEventCreated,
    WsEventUpdated,
    WsForumConfigUpdated,
    WsForumTagDeleted,
    WsForumTagEvent,
    WsForumTagsReordered,
    WsGuildDeleted,
    WsGuildUpdated,
} from '../dtos/response/guild-events.dto';
import {
    GuildEphemeralMessagePayload,
    GuildMessageCreatedPayload,
    GuildMessageUpdatedPayload,
    WsMessageDeleted,
    WsMessagesBulkDeleted,
} from '../dtos/response/guild-message-events.dto';
import {
    WsMemberBanned,
    WsMemberJoined,
    WsMemberKicked,
    WsMemberLeft,
    WsMemberMovedOut,
    WsMemberMuted,
    WsMemberUnmuted,
    WsMemberUpdated,
    WsPresenceChanged,
} from '../dtos/response/guild-member-events.dto';
import {
    WsGuildParticipantJoined,
    WsGuildTrackClosed,
    WsGuildTrackPublished,
    WsGuildVoiceResync,
    WsKickedByOtherDevice,
    WsMovedToChannel,
    WsUserJoinedVoice,
    WsUserLeftVoice,
    WsVoiceCameraChanged,
    WsVoiceDeafenChanged,
    WsVoiceMuteChanged,
    WsVoiceScreenShareStarted,
    WsVoiceScreenShareStopped,
} from '../dtos/response/guild-voice-events.dto';
import {
    WsAutoproxyChanged,
    WsPersonaAdopted,
    WsPersonaChanged,
    WsPersonaDeleted,
    WsPersonaGrantChanged,
    WsPersonaPageCreated,
    WsPersonaPagePulled,
    WsPersonaProfileChanged,
    WsPersonaReviewCompleted,
    WsPersonaReviewRequested,
    WsPersonaUnadopted,
} from '../dtos/response/persona-events.dto';
import {
    WsWikiCategoryCreated,
    WsWikiCategoryDeleted,
    WsWikiCategoryUpdated,
    WsWikiPageCreated,
    WsWikiPageDeleted,
    WsWikiPageUpdated,
} from '../dtos/response/wiki-events.dto';
import {MessagePinnedEvent, MessageUnpinnedEvent, ReactionEvent} from './messaging-websocket.service';

/**
 * Every server → client event this client subscribes to through
 * {@link RealtimeConnectionService.stream}, with the payload the hub sends for it.
 *
 * A name that is not in here cannot be streamed, so adding a server event is one entry plus the
 * subscription that reads it. Domains still consuming the hub through `on` are absent by design;
 * add them here as they migrate.
 */
export interface RealtimeEventMap {
    // Guild voice room state.
    'guild.voice.UserJoinedVoice': WsUserJoinedVoice;
    'guild.voice.UserLeftVoice': WsUserLeftVoice;
    'guild.voice.ParticipantJoined': WsGuildParticipantJoined;
    'guild.voice.TrackPublished': WsGuildTrackPublished;
    'guild.voice.TrackClosed': WsGuildTrackClosed;
    'guild.voice.MuteChanged': WsVoiceMuteChanged;
    'guild.voice.DeafenChanged': WsVoiceDeafenChanged;
    'guild.voice.CameraChanged': WsVoiceCameraChanged;
    'guild.voice.ScreenShareStarted': WsVoiceScreenShareStarted;
    'guild.voice.ScreenShareStopped': WsVoiceScreenShareStopped;
    /** The audience of one screen share changed. Sent to everyone in the channel. */
    'guild.voice.ShareViewersChanged': ShareViewersDto;
    'guild.voice.MovedToChannel': WsMovedToChannel;
    'guild.voice.KickedByOtherDevice': WsKickedByOtherDevice;
    /** Authoritative room state, pushed on join, on publish, and whenever the server decides we are
     * out of date. Replace everything held for this channel; it is not a delta and must not be merged. */
    'guild.voice.Snapshot': VoiceRoomSnapshot;
    /** "You are behind, refetch." Carries a reason, never a delta. */
    'guild.voice.Resync': WsGuildVoiceResync;

    // Voice rings. Plain `guild.` rather than `guild.voice.`: that prefix is reserved for room
    // state, which every client must be able to reconstruct from a version number. A ring is not
    // room state, its audience is somebody who is not in the room and may never be.
    /** Somebody is asking us into a voice channel. Every device of the target gets it. */
    'guild.VoiceRingIncoming': WsVoiceRing;
    /** Our own ring went out. For our other windows, so they stop offering to send it again. */
    'guild.VoiceRingSent': WsVoiceRing;
    /** One event for every way a ring ends. Sent to both sides, on every device. */
    'guild.VoiceRingResolved': WsVoiceRingResolved;
    /** Addressed to one device that answered a ring somebody else had already answered. */
    'guild.VoiceRingDismissed': WsVoiceRingDismissed;

    // Channels, categories and threads.
    'guild.ChannelCreated': WsChannelCreated;
    'guild.ChannelDeleted': WsChannelDeleted;
    'guild.ChannelUpdated': WsChannelUpdated;
    'guild.ChannelReordered': ReorderChannesDto;
    'guild.ChannelMlsStateChanged': WsChannelMlsStateChanged;
    'guild.ChannelMlsJoinRequested': WsChannelMlsJoinRequested;
    'guild.CategoryCreated': WsCategoryCreated;
    'guild.CategoryUpdated': WsCategoryUpdated;
    'guild.CategoryDeleted': WsCategoryDeleted;
    'guild.ThreadCreated': WsThreadCreated;
    'guild.ThreadUpdated': WsThreadUpdated;
    'guild.MessageThreadAttached': WsMessageThreadAttached;
    'guild.UserTyping': ChannelTypingEvent;

    // Wiki.
    'guild.WikiPageCreated': WsWikiPageCreated;
    'guild.WikiPageUpdated': WsWikiPageUpdated;
    'guild.WikiPageDeleted': WsWikiPageDeleted;
    'guild.WikiCategoryCreated': WsWikiCategoryCreated;
    'guild.WikiCategoryUpdated': WsWikiCategoryUpdated;
    'guild.WikiCategoryDeleted': WsWikiCategoryDeleted;

    // Personas.
    'guild.PersonaProfileChanged': WsPersonaProfileChanged;
    /** Guild-owned goes to the guild; a personal character goes to its owner alone. */
    'guild.PersonaCreated': WsPersonaChanged;
    'guild.PersonaUpdated': WsPersonaChanged;
    'guild.PersonaDeleted': WsPersonaDeleted;
    'guild.PersonaAdopted': WsPersonaAdopted;
    'guild.PersonaUnadopted': WsPersonaUnadopted;
    'guild.PersonaReviewRequested': WsPersonaReviewRequested;
    'guild.PersonaReviewCompleted': WsPersonaReviewCompleted;
    'guild.PersonaGrantCreated': WsPersonaGrantChanged;
    'guild.PersonaGrantDeleted': WsPersonaGrantChanged;
    'guild.PersonaPageCreated': WsPersonaPageCreated;
    'guild.PersonaPagePulled': WsPersonaPagePulled;
    'guild.AutoproxyChanged': WsAutoproxyChanged;

    // Scenes and dice.
    /** A scene was opened. The two `guild.ThreadCreated` events beside it do not say a game started. */
    'guild.SceneCreated': SceneCreatedDto;
    'guild.SceneConcluded': SceneConcludedDto;
    /** The turn moved. A patch: the clock and whose turn it is, not the whole scene. */
    'guild.SceneTurnChanged': SceneTurnChangedDto;
    /** Status, cast or rotation moved. Carries no display data for the cast. */
    'guild.SceneUpdated': SceneUpdatedDto;
    /** The nudge, and the escalation to whoever holds `ManageScenes` after a second miss. */
    'guild.SceneTurnNudge': SceneTurnNudgeDto;
    /** The guild's whole archive vocabulary, replaced. Never a delta. */
    'guild.SceneTaxonomyChanged': SceneTaxonomyDto;
    'guild.SceneTagsChanged': SceneTagsChangedDto;
    /** Somebody wants a character in a closed scene. Reaches ManageScenes holders only. */
    'guild.SceneJoinRequested': SceneJoinRequestedDto;
    /** The answer to an ask. `decisionReason` travels here and nowhere else. */
    'guild.SceneJoinRequestResolved': SceneJoinRequestResolvedDto;
    /** A roll landed. The message carries the faces; this carries who rolled and what it came to. */
    'guild.DiceRolled': DiceRolledDto;

    // Members.
    'guild.MemberBanned': WsMemberBanned;
    'guild.MemberKicked': WsMemberKicked;
    'guild.MemberMovedOut': WsMemberMovedOut;
    'guild.MemberMuted': WsMemberMuted;
    'guild.MemberUnmuted': WsMemberUnmuted;
    'guild.MemberLeft': WsMemberLeft;
    'guild.MemberJoined': WsMemberJoined;
    /** Roles or nickname changed. Consumers must re-read the row, not patch it. */
    'guild.MemberUpdated': WsMemberUpdated;
    'guild.PresenceChanged': WsPresenceChanged;

    // Guild lifecycle.
    /**
     * A guild appeared for this account, created on another device or an invite accepted there.
     * Carries the whole `GuildDto`, so the rail can add it without a round trip.
     */
    'guild.GuildCreated': GuildDto;
    'guild.GuildDeleted': WsGuildDeleted;
    'guild.GuildUpdated': WsGuildUpdated;
    'guild.RolesReordered': ReorderRolesDto;
    'guild.EmojiCreated': WsEmojiCreated;
    'guild.EmojiDeleted': WsEmojiDeleted;
    'guild.BotInstalled': WsBotInstalled;
    'guild.BotUninstalled': WsBotUninstalled;
    'guild.EventCreated': WsEventCreated;
    'guild.EventUpdated': WsEventUpdated;
    'guild.EventCancelled': WsEventCancelled;

    // Forums.
    'guild.ForumTagCreated': WsForumTagEvent;
    'guild.ForumTagUpdated': WsForumTagEvent;
    'guild.ForumTagDeleted': WsForumTagDeleted;
    'guild.ForumTagsReordered': WsForumTagsReordered;
    'guild.ForumConfigUpdated': WsForumConfigUpdated;

    // Messages.
    'guild.MessageCreated': GuildMessageCreatedPayload;
    'guild.MessageUpdated': GuildMessageUpdatedPayload;
    'guild.MessageDeleted': WsMessageDeleted;
    'guild.MessagesBulkDeleted': WsMessagesBulkDeleted;
    'guild.EphemeralMessageCreated': GuildEphemeralMessagePayload;
    'guild.ReactionCreated': ReactionEvent;
    'guild.ReactionRemoved': ReactionEvent;
    'guild.MessagePinned': MessagePinnedEvent;
    'guild.MessageUnpinned': MessageUnpinnedEvent;
    /**
     * A bot wants a form on screen. The answer goes back over HTTP, not this socket:
     * `POST /bots/guilds/{g}/channels/{c}/modal-submit`, carrying the `customId` from this event.
     */
    'guild.ModalOpen': WsBotModalOpen;
}

export type RealtimeEvent = keyof RealtimeEventMap;

export type PayloadOf<K extends RealtimeEvent> = RealtimeEventMap[K];
