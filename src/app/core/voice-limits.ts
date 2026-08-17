import {
    AUDIO_ONLY_RUNG,
    EntitlementRungDto,
    EntitlementValueDto,
    numericCeiling,
    rungMetrics,
    VoiceRoomLimitsDto,
} from '../dtos/response/entitlement.dto';
import {VideoCeiling} from '../models/stream-preset';

/**
 * Reading a voice room's `limits` block. Null means "nothing said" everywhere in this file: draw no
 * denominator, disable nothing, and let the server answer.
 */

/** A count against a ceiling: the two halves of every "X of Y" in a room. */
export interface SlotCount {
    used: number;
    max: number;
}

/** Whether the ceiling is full. `used` can exceed `max` after a downgrade mid-call. */
export function isFull(slots: SlotCount | null): boolean {
    return slots !== null && slots.used >= slots.max;
}

/** Whether the granted rung is audio-only, answerable from the room snapshot alone. */
export function isAudioOnlyRung(value: EntitlementValueDto | undefined): boolean {
    return value?.kind === 'ladder' && value.rung === AUDIO_ONLY_RUNG;
}

/** What the room's granted rung permits, from the published ladder. Null clamps nothing. */
export function videoCeilingOf(
    limits: VoiceRoomLimitsDto | null | undefined,
    ladder: EntitlementRungDto[] | undefined,
): VideoCeiling | null {
    const value = limits?.videoCeiling;
    if (!value) return null;
    // Answerable without the ladder, and the one rung where that matters most.
    if (isAudioOnlyRung(value)) return {maxHeight: 0, maxFramerate: 0};
    return rungMetrics(ladder, value);
}

/** "2 of 2 people are sharing", or null when nothing counts publishers here. */
export function publisherSlotsOf(limits: VoiceRoomLimitsDto | null | undefined): SlotCount | null {
    const max = numericCeiling(limits?.maxPublishers);
    if (max === null) return null;
    // The count is room state and rides the same block; without it there is no numerator.
    const used = limits?.publisherCount;
    return typeof used === 'number' ? {used, max} : null;
}

/** "7 of 10 people are here", or null when nothing caps the room. */
export function participantSlotsOf(
    limits: VoiceRoomLimitsDto | null | undefined,
    present: number,
): SlotCount | null {
    const max = numericCeiling(limits?.maxParticipants);
    return max === null ? null : {used: present, max};
}

/**
 * Why this client may not start publishing video, or null when it may. Audio-only is reported
 * before a full publisher list, and a client already publishing is never blocked.
 */
export function videoPublishBlock(
    limits: VoiceRoomLimitsDto | null | undefined,
    alreadyPublishing: boolean,
): 'audio_only' | 'publishers_full' | null {
    if (alreadyPublishing) return null;
    if (isAudioOnlyRung(limits?.videoCeiling)) return 'audio_only';
    return isFull(publisherSlotsOf(limits)) ? 'publishers_full' : null;
}

/** The sentence for a block, as a literal key. Exported so a spec can assert both resolve. */
export const VIDEO_BLOCK_KEYS: Record<'audio_only' | 'publishers_full', string> = {
    audio_only: 'VOICE.DEGRADED.AUDIO_ONLY',
    publishers_full: 'VOICE.DEGRADED.PUBLISHERS_FULL',
};

/**
 * What a room says about a limit, on top of the generic reason sentence. Keys must stay literal;
 * `i18n-keys.spec.ts` cannot see a computed one.
 */
const SURFACE_KEYS: Record<string, string> = {
    'voice.video_ceiling': 'VOICE.DEGRADED.QUALITY_CAPPED',
    'voice.max_publishers': 'VOICE.DEGRADED.PUBLISHERS_FULL',
    'voice.max_participants': 'VOICE.DEGRADED.ROOM_AT_LIMIT',
};

/** Every literal key this file can produce, for the spec that checks they all resolve. */
export const VOICE_LIMIT_TRANSLATION_KEYS: readonly string[] = [
    ...Object.values(VIDEO_BLOCK_KEYS),
    ...Object.values(SURFACE_KEYS),
];

/** What was reduced, named, or null for a key this build has no sentence for. */
export function voiceSurfaceKey(key: string, granted: EntitlementValueDto | null | undefined): string | null {
    if (key === 'voice.video_ceiling' && isAudioOnlyRung(granted ?? undefined)) {
        return VIDEO_BLOCK_KEYS.audio_only;
    }
    return SURFACE_KEYS[key] ?? null;
}

/** The rung name to put in a sentence, or null when what was granted is not a rung. */
export function grantedRungName(granted: EntitlementValueDto | null | undefined): string | null {
    return granted?.kind === 'ladder' ? granted.rung : null;
}
