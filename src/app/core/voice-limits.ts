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
 * Reading a voice room's `limits` block, which is the half of the entitlement contract the room
 * itself carries.
 *
 * <p>Everything here answers a question the room surface asks before anything is refused:
 * what the denominator is, whether the share button would only be turned down, and how far the
 * quality picker may go. What actually bit arrives separately as a `degradations[]` on the join or
 * publish reply - see `Echo/docs/specs/entitlements-frontend-guide.md` section 8.</p>
 *
 * <p><b>Null is the answer for "nothing said", everywhere in this file.</b> An absent limits block,
 * an unlimited key and a key in a shape it does not declare all have to be treated the same by the
 * caller anyway: draw no denominator, disable nothing, and let the server answer.</p>
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

/**
 * Whether the granted rung is audio-only.
 *
 * <p>Checked by name before metrics, and that ordering is the point: `none` is a named rung on the
 * wire, so this is answerable from the room snapshot alone - before, or entirely without, the
 * entitlement snapshot that publishes the ladder. A room that reads as audio-only only once a second
 * request lands would show a live camera button for as long as that took.</p>
 */
export function isAudioOnlyRung(value: EntitlementValueDto | undefined): boolean {
    return value?.kind === 'ladder' && value.rung === AUDIO_ONLY_RUNG;
}

/**
 * What the room's granted rung permits, from the ladder the entitlement snapshot published.
 *
 * <p>Null when nothing is known, which is the state a client is in until it has both halves - and
 * the state it stays in for a rung this build has never heard of. Null clamps nothing, which is
 * correct: the alternative is guessing a mapping the server publishes precisely so nobody guesses.
 * </p>
 */
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
    // The count is room state and rides the same block; without it there is a ceiling and no
    // numerator, which is half a sentence rather than a denominator.
    const used = limits?.publisherCount;
    return typeof used === 'number' ? {used, max} : null;
}

/**
 * "7 of 10 people are here", or null when nothing caps the room.
 *
 * <p>The numerator is the caller's own roster rather than anything on the wire: the snapshot lists
 * the participants, so a second count of them would be a number that could disagree with the faces
 * on screen.</p>
 */
export function participantSlotsOf(
    limits: VoiceRoomLimitsDto | null | undefined,
    present: number,
): SlotCount | null {
    const max = numericCeiling(limits?.maxParticipants);
    return max === null ? null : {used: present, max};
}

/**
 * Why this client may not start publishing video, or null when it may.
 *
 * <p>Two conditions and an order. Audio-only is a property of the plan and holds however empty the
 * room is; a full publisher list is a property of the moment and clears when somebody stops. Naming
 * the first one first is what stops "2 of 2 sharing" being offered as the explanation for a room
 * that would refuse a third publisher anyway.</p>
 *
 * <p>Never blocks a client that is already publishing. Stopping is always allowed, and a ceiling
 * that arrived after the publish did must not strand a live share behind a dead button.</p>
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
 * What a room says about a limit, on top of the generic reason sentence.
 *
 * <p>`ENTITLEMENT.REASON.*` says which side bound and who can move it, which is true of every
 * surface and specific to none. In a voice room that leaves "this server's plan doesn't stretch that
 * far" hanging with no statement of what was actually reduced, so each key that can bite here also
 * names the effect.</p>
 *
 * <p><b>Literal keys, like every other table on this path.</b> A computed `'VOICE.DEGRADED.' + x`
 * matches nothing in `i18n-keys.spec.ts` and renders raw to a user with every test green.</p>
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

/**
 * What was reduced, named, or null for a key this build has no sentence for.
 *
 * <p>Null is a rendering, not a hole: the reason sentence still says which side bound and the
 * remedy still says who can move it, so an unknown key degrades to the generic pair rather than to
 * a raw code or a blank card.</p>
 *
 * <p>A video ceiling of `none` gets its own sentence rather than "capped at none", which is the one
 * place where naming the rung would be actively wrong - audio-only is a state, not a quality.</p>
 */
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
