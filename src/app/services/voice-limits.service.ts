import {computed, inject, Injectable, signal} from '@angular/core';
import {Subject} from 'rxjs';
import {
    describeEntitlementLimit,
    entitlementDenialOf,
    EntitlementNotice,
} from '../core/entitlement-message';
import {
    grantedRungName,
    isAudioOnlyRung,
    isFull,
    participantSlotsOf,
    publisherSlotsOf,
    SlotCount,
    videoCeilingOf,
    videoPublishBlock,
    voiceSurfaceKey,
} from '../core/voice-limits';
import {
    degradationsOf,
    EntitlementValueDto,
    VoiceRoomLimitsDto,
} from '../dtos/response/entitlement.dto';
import {VideoCeiling} from '../models/stream-preset';
import {VoiceRoomSnapshot} from '../models/voice-room';
import {EntitlementStore, MY_ENTITLEMENTS} from '../stores/entitlement.store';
import {VoicePublishResponse} from './guild-voice.service';

/** The `video_quality` ladder is the only one a room reads. */
const VIDEO_LADDER = 'video_quality';

/**
 * One limit the user is standing in, ready to render.
 *
 * <p>{@link EntitlementNotice} answers "which side bound, and who can move it", which is true of
 * every surface. The three fields added here are what makes it a sentence about *this room*: what
 * was reduced, what it was reduced to, and whether the server refused outright or merely gave
 * less.</p>
 */
export interface VoiceLimitNotice extends EntitlementNotice {
    /** The catalogue key, so one condition replaces itself rather than stacking a card per join. */
    key: string;
    /** What the surface says beyond the reason, or null for a key this build cannot name. */
    surfaceKey: string | null;
    /** The rung the server settled on, for a sentence that names it. */
    rung: string | null;
    /** What was granted, kept so an arriving snapshot can tell a stale notice from a live one. */
    granted: EntitlementValueDto | null;
    /** True for a `403` that could not degrade, false for a `200` that gave less. */
    refused: boolean;
}

/**
 * Everything a voice surface knows about what its plan allows, for as long as it is in the room.
 *
 * <p><b>Persistent, because the condition is.</b> "Your camera is off because this server is on the
 * free plan" is not an event that happened four seconds ago; it is the state of the room, and it
 * stays true until the plan or the room changes. It used to be a toast, which meant the one thing a
 * user could do about it - read it - had a four second window, and nothing in the voice UI held the
 * reason afterwards.</p>
 *
 * <p>Two sources feed it and they answer different questions. The room snapshot's `limits` block
 * says what is <i>allowed</i>, and is what pre-empts: denominators, a share button that is disabled
 * before it is pressed, a picker that stops where the rung does. The `degradations[]` on a join or
 * publish reply say what actually <i>bit</i>, and are what gets a sentence. Neither substitutes for
 * the other - see `Echo/docs/specs/entitlements-frontend-guide.md` section 8.</p>
 */
@Injectable({providedIn: 'root'})
export class VoiceLimitsService {
    private entitlements = inject(EntitlementStore);

    /** The guild whose ladder applies, or null in a direct call - which has no guild plan behind it. */
    private readonly guildId = signal<string | null>(null);
    private readonly limitsSignal = signal<VoiceRoomLimitsDto | null>(null);
    private readonly noticesByKey = signal<Record<string, VoiceLimitNotice>>({});

    /** What the room allows, or null when nothing has said - which is not the same as "no limits". */
    readonly limits = this.limitsSignal.asReadonly();

    /**
     * Every limit currently in force, in the order the server named them.
     *
     * <p>Keyed by catalogue key underneath, so rejoining a room the plan still caps replaces the
     * card rather than adding a second one saying the same thing.</p>
     */
    readonly notices = computed<VoiceLimitNotice[]>(() => Object.values(this.noticesByKey()));

    /**
     * What the granted rung permits, or null while either half is missing.
     *
     * <p>The rung is on the room snapshot and the metrics are on the entitlement snapshot, and this
     * is the only place the two meet. Null clamps nothing, which is the right answer for "one half
     * has not arrived": the server clamps and says so, and a picker that guessed in the meantime
     * would be guessing at a pricing decision.</p>
     */
    readonly videoCeiling = computed<VideoCeiling | null>(() =>
        videoCeilingOf(this.limitsSignal(), this.entitlements.ladder(VIDEO_LADDER, this.guildId())));

    /**
     * Whether this room carries no video at all.
     *
     * <p>A state to render, never an error and never a broken button: `none` is a real rung, and it
     * is how "this guild is over its video budget" is said without refusing the call. True the
     * moment the room says so, whether or not anybody has tried to publish - a degradation only
     * arrives when something was actually asked for, and a room nobody has asked anything of still
     * has to say what it is.</p>
     */
    readonly audioOnly = computed(() => isAudioOnlyRung(this.limitsSignal()?.videoCeiling));

    /** "2 of 2 sharing", or null when nothing counts publishers here. */
    readonly publisherSlots = computed<SlotCount | null>(() => publisherSlotsOf(this.limitsSignal()));

    /** True when every publisher slot is taken, which is a reason and not an error. */
    readonly publishersFull = computed(() => isFull(this.publisherSlots()));

    /**
     * A publish the server refused outright, once, as it happens.
     *
     * <p>The one place a toast is still the right shape. Everything else here is a condition and
     * gets a card that stays; this is the answer to a button somebody just pressed, and a button
     * press with no response at all is the failure mode the pre-emptive disabling cannot cover -
     * the ceiling can move between the render and the click.</p>
     *
     * <p>The card is filed too. The toast says "that did not happen"; the card says why, and is
     * still there when the toast is not.</p>
     */
    readonly refused$ = new Subject<VoiceLimitNotice>();

    /** "7 of 10 people are here", against a roster the caller counts itself. */
    participantSlots(present: number): SlotCount | null {
        return participantSlotsOf(this.limitsSignal(), present);
    }

    /**
     * Why this client may not start publishing video, or null when it may.
     *
     * @param alreadyPublishing never blocked, so a ceiling that lands mid-share cannot strand a
     *        live publication behind a dead stop button.
     */
    videoBlock(alreadyPublishing: boolean): 'audio_only' | 'publishers_full' | null {
        return videoPublishBlock(this.limitsSignal(), alreadyPublishing);
    }

    /**
     * Entering a room. Clears everything the last one said and asks for the ladders.
     *
     * <p>The ladder read is what turns a rung name into a clamp, and it is asked for here rather
     * than when a picker opens: by then the user is already looking at options the plan does not
     * include.</p>
     */
    enterRoom(guildId: string | null): void {
        this.guildId.set(guildId);
        this.limitsSignal.set(null);
        this.noticesByKey.set({});
        this.entitlements.ensureLoaded(MY_ENTITLEMENTS);
        if (guildId) this.entitlements.ensureLoaded({kind: 'guild', id: guildId});
    }

    /** Out of every room. Nothing here outlives the call it was about. */
    clear(): void {
        this.guildId.set(null);
        this.limitsSignal.set(null);
        this.noticesByKey.set({});
    }

    /**
     * Take the limits off a room snapshot.
     *
     * <p><b>An absent block leaves what is held alone</b>, unlike the roster beside it. The roster
     * is replaced wholesale because a snapshot is the authority on it; `limits` is documented as
     * "no limit information" when absent rather than "no limits", so treating it as a wholesale
     * replacement would let one snapshot from an older server node quietly re-enable a camera the
     * plan does not cover.</p>
     */
    applySnapshot(snapshot: VoiceRoomSnapshot): void {
        const limits = snapshot.limits;
        if (!limits) return;
        this.limitsSignal.set(limits);
        this.dropStaleNotices(limits);
    }

    /**
     * File whatever a `200` reduced.
     *
     * <p>Two surfaces carry one, and they are the two moments something can be asked for: the join
     * reply, when the room seats an arrival it cannot seat in full, and the <b>publish</b> reply,
     * when a declared resolution is clamped to the rung the plan allows. The negotiate reply used to
     * be the second of those and is gone with the SDP relay - the ceiling is now re-decided against
     * what a publish declares, so that is where the sentence rides.</p>
     *
     * <p>Absent and empty mean the same thing and both are the normal case - a response with nothing
     * reduced is byte-identical to what a client before this contract received. Nothing here is an
     * error path; a reduction the server could not make at all is a `403` and reaches
     * {@link noteDenial} instead.</p>
     *
     * <p>{@link degradationsOf} does the reading, here and nowhere else. The block is optional on
     * every surface that carries it, so a caller that dug it out itself would be a second place for
     * "absent" and "empty" to stop meaning the same thing.</p>
     */
    noteDegradations(response: VoicePublishResponse | VoiceRoomSnapshot | null | undefined): void {
        const degradations = degradationsOf(response);
        if (degradations.length === 0) return;

        const next = {...this.noticesByKey()};
        for (const degradation of degradations) {
            next[degradation.key] = this.toNotice(degradation.key, degradation.granted,
                describeEntitlementLimit(degradation), false);
        }
        this.noticesByKey.set(next);
    }

    /**
     * File a refusal the server could not degrade, and say whether that is what this was.
     *
     * <p>Returns null for anything else, and the caller then falls back to its own error handling.
     * A permission refusal carries its own codes and lands here as null, which is what keeps "you
     * cannot do this" from rendering as "buy more".</p>
     */
    noteDenial(err: unknown): VoiceLimitNotice | null {
        const denial = entitlementDenialOf(err);
        if (!denial) return null;

        const notice = this.toNotice(denial.key, denial.granted ?? null,
            describeEntitlementLimit(denial), true);
        this.noticesByKey.set({...this.noticesByKey(), [denial.key]: notice});
        this.refused$.next(notice);
        return notice;
    }

    private toNotice(
        key: string,
        granted: EntitlementValueDto | null,
        notice: EntitlementNotice,
        refused: boolean,
    ): VoiceLimitNotice {
        return {
            ...notice,
            key,
            surfaceKey: voiceSurfaceKey(key, granted),
            rung: grantedRungName(granted),
            granted,
            refused,
        };
    }

    /**
     * Retire a notice the arriving limits contradict.
     *
     * <p>A degradation is a statement about one moment, and a room outlives it: a boost lands, the
     * ceiling moves, and the card explaining a cap that no longer applies is now a lie on screen
     * with no event of its own to clear it. The limits block is that event - it is the only thing
     * that says what is true *now* - so a notice that disagrees with it goes.</p>
     *
     * <p>Only where the block can actually contradict the notice. A key it says nothing about is
     * left alone rather than optimistically cleared: silence is not evidence.</p>
     */
    private dropStaleNotices(limits: VoiceRoomLimitsDto): void {
        const held = this.noticesByKey();
        const next: Record<string, VoiceLimitNotice> = {};
        let changed = false;

        for (const [key, notice] of Object.entries(held)) {
            if (this.isStale(key, notice, limits)) {
                changed = true;
                continue;
            }
            next[key] = notice;
        }
        if (changed) this.noticesByKey.set(next);
    }

    private isStale(key: string, notice: VoiceLimitNotice, limits: VoiceRoomLimitsDto): boolean {
        if (key === 'voice.video_ceiling') {
            const current = limits.videoCeiling;
            if (current?.kind !== 'ladder' || notice.granted?.kind !== 'ladder') return false;
            return current.rung !== notice.granted.rung;
        }
        // A slot that has freed up. The count moves on every publish and unpublish, so this is the
        // one notice that clears itself simply by somebody stopping their share.
        if (key === 'voice.max_publishers') return !isFull(publisherSlotsOf(limits));
        return false;
    }
}
