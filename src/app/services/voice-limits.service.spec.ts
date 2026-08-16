/**
 * The room's entitlement state, for as long as the room lasts.
 *
 * <p>Two sources answering two different questions: the snapshot's `limits` block says what is
 * allowed and is what pre-empts, and `degradations[]` says what actually bit and is what gets a
 * sentence. The thing this suite is really about is that neither of them is a toast - a ceiling is
 * the state of the room, and announcing it once was the whole of the explanation a user got for a
 * camera button that had stopped working.</p>
 */
import {TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';
import {EntitlementRungDto, EntitlementDegradationDto, VoiceRoomLimitsDto} from '../dtos/response/entitlement.dto';
import {VoiceRoomSnapshot} from '../models/voice-room';
import {EntitlementStore} from '../stores/entitlement.store';
import {VoicePublishResponse} from './guild-voice.service';
import {VoiceLimitsService} from './voice-limits.service';
import {HttpErrorResponse} from '@angular/common/http';

const LADDER: EntitlementRungDto[] = [
    {rung: 'none', rank: 0, maxHeight: 0, maxFramerate: 0},
    {rung: '720p30', rank: 2, maxHeight: 720, maxFramerate: 30},
    {rung: '1080p60', rank: 4, maxHeight: 1080, maxFramerate: 60},
];

/** `null` means no ladder is held, which is different from the default and is a case in its own right. */
function setup(ladder: EntitlementRungDto[] | null = LADDER) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            {
                provide: EntitlementStore,
                useValue: {ladder: () => ladder ?? undefined, ensureLoaded: () => void 0},
            },
        ],
    });
    return TestBed.inject(VoiceLimitsService);
}

function snapshot(limits?: VoiceRoomLimitsDto): VoiceRoomSnapshot {
    return {
        roomId: 'chan-1', kind: 'channel', guildId: 'guild-1',
        instanceId: 'inst-1', version: 1, participants: [], limits,
    };
}

const CAPPED: VoiceRoomLimitsDto = {
    maxParticipants: {kind: 'numeric', value: 10, unlimited: false},
    videoCeiling: {kind: 'ladder', rung: '720p30', rank: 2, ladder: 'video_quality'},
    maxPublishers: {kind: 'numeric', value: 2, unlimited: false},
    publisherCount: 1,
};

/**
 * The reply to `POST .../voice/publish`, which is where a degradation rides now.
 *
 * <p>Typed rather than a bag with a `degradations` key on it: the negotiate reply this used to be
 * read from no longer exists, and a literal would go on passing long after the field moved.</p>
 */
function publishReply(degradations?: EntitlementDegradationDto[]): VoicePublishResponse {
    return {
        identity: 'user-1',
        rung: '720p30',
        height: 720,
        framerate: 30,
        maxLayer: 'b',
        ...(degradations ? {degradations} : {}),
    };
}

const CEILING_DEGRADATION: EntitlementDegradationDto = {
    key: 'voice.video_ceiling',
    requested: {kind: 'ladder', rung: '1080p60', rank: 4},
    granted: {kind: 'ladder', rung: '720p30', rank: 2},
    reason: 'guild_plan_limit',
    boundBy: 'guild',
    remedy: 'upgrade_guild',
    actorCanRemedy: true,
    subject: {kind: 'guild', id: 'guild-1'},
};

describe('what the room allows', () => {
    it('reads the ceiling, the slots and the denominators off the snapshot', () => {
        const service = setup();
        service.enterRoom('guild-1');

        service.applySnapshot(snapshot(CAPPED));

        expect(service.videoCeiling()).toEqual({maxHeight: 720, maxFramerate: 30});
        expect(service.publisherSlots()).toEqual({used: 1, max: 2});
        expect(service.publishersFull()).toBe(false);
        expect(service.participantSlots(7)).toEqual({used: 7, max: 10});
        expect(service.videoBlock(false)).toBeNull();
    });

    it('disables video before it is asked for, once the room is out of publisher slots', () => {
        const service = setup();
        service.enterRoom('guild-1');

        service.applySnapshot(snapshot({...CAPPED, publisherCount: 2}));

        expect(service.publishersFull()).toBe(true);
        expect(service.videoBlock(false)).toBe('publishers_full');
    });

    /**
     * Edge, and the one place this deliberately differs from the roster beside it. The roster is
     * replaced wholesale because a snapshot is the authority on it; `limits` is documented as "no
     * limit information" when absent, so treating absence as a wholesale replacement would let one
     * snapshot quietly re-enable a camera the plan does not cover.
     */
    it('leaves the held limits alone when a snapshot carries none', () => {
        const service = setup();
        service.enterRoom('guild-1');
        service.applySnapshot(snapshot(CAPPED));

        service.applySnapshot(snapshot(undefined));

        expect(service.videoCeiling()).toEqual({maxHeight: 720, maxFramerate: 30});
    });

    /** Negative: an instance that computes no limits at all leaves every control live. */
    it('clamps and blocks nothing when no room has said anything', () => {
        const service = setup();
        service.enterRoom('guild-1');

        expect(service.limits()).toBeNull();
        expect(service.videoCeiling()).toBeNull();
        expect(service.publisherSlots()).toBeNull();
        expect(service.participantSlots(3)).toBeNull();
        expect(service.videoBlock(false)).toBeNull();
    });

    /** The rung is on the room snapshot and the metrics are on the entitlement one. */
    it('cannot clamp until the ladder has landed, and says so with null', () => {
        const service = setup(null);
        service.enterRoom('guild-1');
        service.applySnapshot(snapshot(CAPPED));

        expect(service.videoCeiling()).toBeNull();
        // Audio-only is still answerable, because `none` is a name rather than a measurement.
        service.applySnapshot(snapshot({videoCeiling: {kind: 'ladder', rung: 'none', rank: 0}}));
        expect(service.videoBlock(false)).toBe('audio_only');
    });
});

describe('what the room reduced', () => {
    it('holds a degradation as a card rather than announcing it', () => {
        const service = setup();
        service.enterRoom('guild-1');

        service.noteDegradations(publishReply([CEILING_DEGRADATION]));

        expect(service.notices()).toEqual([expect.objectContaining({
            key: 'voice.video_ceiling',
            surfaceKey: 'VOICE.DEGRADED.QUALITY_CAPPED',
            rung: '720p30',
            messageKey: 'ENTITLEMENT.REASON.GUILD_PLAN_LIMIT',
            // The server said this caller can act, so there is a button and no "ask an admin".
            ctaKey: 'ENTITLEMENT.CTA.UPGRADE_SERVER',
            hintKey: null,
            refused: false,
        })]);
    });

    /**
     * The publish reply is the surface that carries this now. It used to be the negotiate reply,
     * which no longer exists on either service - the SDP relay went with the SFU change - and the
     * declaration a publish makes is what the ceiling is re-decided against.
     */
    it('reads the reduction off a publish reply', () => {
        const service = setup();
        service.enterRoom('guild-1');

        service.noteDegradations(publishReply([CEILING_DEGRADATION]));

        expect(service.notices()).toHaveLength(1);
        expect(service.notices()[0].rung).toBe('720p30');
    });

    /**
     * The join reply is the other one, and it stays: joining a full room lands you in it on an
     * audio-only seat, and nothing has been published at that point for a publish reply to describe.
     */
    it('still reads the reduction off a join reply', () => {
        const service = setup();
        service.enterRoom('guild-1');

        service.noteDegradations(
            {...snapshot(CAPPED), degradations: [CEILING_DEGRADATION]} as VoiceRoomSnapshot);

        expect(service.notices()).toHaveLength(1);
    });

    /** One condition, one card. Rejoining a room the plan still caps must not stack a second. */
    it('replaces a card for the same key rather than stacking one per join', () => {
        const service = setup();
        service.enterRoom('guild-1');

        service.noteDegradations(publishReply([CEILING_DEGRADATION]));
        service.noteDegradations(publishReply([CEILING_DEGRADATION]));

        expect(service.notices()).toHaveLength(1);
    });

    /** Absent and empty mean the same thing, and both are the normal case. */
    it('files nothing for a response that reduced nothing', () => {
        const service = setup();
        service.enterRoom('guild-1');

        service.noteDegradations(publishReply());
        service.noteDegradations(publishReply([]));
        service.noteDegradations(null);

        expect(service.notices()).toEqual([]);
    });

    /**
     * A degradation describes one moment and the room outlives it. When a boost lands and the
     * ceiling moves, the card explaining a cap that no longer applies is a lie on screen with no
     * event of its own to clear it - so the limits block, which is what says what is true now,
     * retires it.
     */
    it('retires a ceiling card once the snapshot names a different rung', () => {
        const service = setup();
        service.enterRoom('guild-1');
        service.noteDegradations(publishReply([CEILING_DEGRADATION]));

        service.applySnapshot(snapshot({
            videoCeiling: {kind: 'ladder', rung: '1080p60', rank: 4, ladder: 'video_quality'},
        }));

        expect(service.notices()).toEqual([]);
    });

    it('keeps a ceiling card while the snapshot still names the rung it was granted', () => {
        const service = setup();
        service.enterRoom('guild-1');
        service.noteDegradations(publishReply([CEILING_DEGRADATION]));

        service.applySnapshot(snapshot(CAPPED));

        expect(service.notices()).toHaveLength(1);
    });

    it('retires a publishers-full card the moment somebody stops sharing', () => {
        const service = setup();
        service.enterRoom('guild-1');
        service.noteDegradations(publishReply([{
            ...CEILING_DEGRADATION,
            key: 'voice.max_publishers',
            requested: {kind: 'numeric', value: 3, unlimited: false},
            granted: {kind: 'numeric', value: 2, unlimited: false},
        }]));
        service.applySnapshot(snapshot({...CAPPED, publisherCount: 2}));
        expect(service.notices()).toHaveLength(1);

        service.applySnapshot(snapshot({...CAPPED, publisherCount: 1}));

        expect(service.notices()).toEqual([]);
    });
});

describe('what the room refused', () => {
    function denial(body: unknown): HttpErrorResponse {
        return new HttpErrorResponse({status: 403, error: body});
    }

    it('files a 403 as a card and emits it once for the acknowledgement', () => {
        const service = setup();
        service.enterRoom('guild-1');
        const seen: string[] = [];
        service.refused$.subscribe(n => seen.push(n.messageKey));

        const notice = service.noteDenial(denial({
            code: 'guild_plan_limit',
            key: 'voice.video_ceiling',
            granted: {kind: 'ladder', rung: 'none', rank: 0},
            reason: 'guild_plan_limit',
            boundBy: 'guild',
            remedy: 'upgrade_guild',
            actorCanRemedy: false,
            subject: {kind: 'guild', id: 'guild-1'},
            retryable: false,
        }));

        expect(notice).toEqual(expect.objectContaining({
            refused: true,
            surfaceKey: 'VOICE.DEGRADED.AUDIO_ONLY',
            messageKey: 'ENTITLEMENT.REASON.GUILD_PLAN_LIMIT',
            // Cannot act, so a sentence naming who can and no button that would answer 403.
            ctaKey: null,
            hintKey: 'ENTITLEMENT.CTA.ASK_OWNER',
        }));
        expect(seen).toEqual(['ENTITLEMENT.REASON.GUILD_PLAN_LIMIT']);
        expect(service.notices()).toHaveLength(1);
    });

    /**
     * Edge: a code added after this build shipped. The generic sentence, and the button suppressed
     * whatever the remedy says - a remedy this build does not understand is one it should not offer.
     */
    it('renders a reason it has never heard of generically, with no button', () => {
        const service = setup();

        const notice = service.noteDenial(denial({
            code: 'quota_of_the_future',
            key: 'voice.video_ceiling',
            reason: 'quota_of_the_future',
            remedy: 'upgrade_guild',
            actorCanRemedy: true,
            subject: {kind: 'guild', id: 'guild-1'},
            retryable: false,
        }));

        expect(notice).toEqual(expect.objectContaining({
            messageKey: 'ENTITLEMENT.REASON.UNKNOWN',
            ctaKey: null,
            hintKey: null,
        }));
    });

    /**
     * Negative, and the one that keeps "you cannot do this" from rendering as "buy more": a
     * permission refusal carries its own codes and is not an entitlement refusal.
     */
    it('files nothing for a 403 that is not an entitlement refusal', () => {
        const service = setup();
        const seen: unknown[] = [];
        service.refused$.subscribe(n => seen.push(n));

        expect(service.noteDenial(denial({code: 'forbidden'}))).toBeNull();
        expect(service.noteDenial(new HttpErrorResponse({status: 500}))).toBeNull();
        expect(service.noteDenial(new Error('offline'))).toBeNull();
        expect(service.notices()).toEqual([]);
        expect(seen).toEqual([]);
    });
});

describe('leaving', () => {
    /** Nothing a room said about its plan may follow the user into the next one. */
    it('clears every ceiling and every card', () => {
        const service = setup();
        service.enterRoom('guild-1');
        service.applySnapshot(snapshot(CAPPED));
        service.noteDegradations(publishReply([CEILING_DEGRADATION]));

        service.clear();

        expect(service.limits()).toBeNull();
        expect(service.notices()).toEqual([]);
        expect(service.videoCeiling()).toBeNull();
    });

    it('starts the next room from nothing rather than from the last one', () => {
        const service = setup();
        service.enterRoom('guild-1');
        service.applySnapshot(snapshot(CAPPED));
        service.noteDegradations(publishReply([CEILING_DEGRADATION]));

        service.enterRoom('guild-2');

        expect(service.notices()).toEqual([]);
        expect(service.videoCeiling()).toBeNull();
    });
});
