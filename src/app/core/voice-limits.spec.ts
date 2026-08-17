/** Reading a room's `limits` block: denominators, disabled controls, and the quality clamp. */
import {describe, expect, it} from 'vitest';
import {AUDIO_ONLY_RUNG, EntitlementRungDto, VoiceRoomLimitsDto} from '../dtos/response/entitlement.dto';
import {
    grantedRungName,
    isAudioOnlyRung,
    isFull,
    participantSlotsOf,
    publisherSlotsOf,
    VIDEO_BLOCK_KEYS,
    videoCeilingOf,
    videoPublishBlock,
    VOICE_LIMIT_TRANSLATION_KEYS,
    voiceSurfaceKey,
} from './voice-limits';

/** The ladder as the server publishes it, which is the only place these numbers come from. */
const LADDER: EntitlementRungDto[] = [
    {rung: 'none', rank: 0, maxHeight: 0, maxFramerate: 0},
    {rung: '480p30', rank: 1, maxHeight: 480, maxFramerate: 30},
    {rung: '720p30', rank: 2, maxHeight: 720, maxFramerate: 30},
    {rung: '1080p30', rank: 3, maxHeight: 1080, maxFramerate: 30},
    {rung: '1080p60', rank: 4, maxHeight: 1080, maxFramerate: 60},
];

const CAPPED: VoiceRoomLimitsDto = {
    maxParticipants: {kind: 'numeric', value: 10, unlimited: false},
    videoCeiling: {kind: 'ladder', rung: '720p30', rank: 2, ladder: 'video_quality'},
    maxPublishers: {kind: 'numeric', value: 2, unlimited: false},
    publisherCount: 1,
};

describe('the video ceiling', () => {
    it('resolves the granted rung against the published ladder', () => {
        expect(videoCeilingOf(CAPPED, LADDER)).toEqual({maxHeight: 720, maxFramerate: 30});
    });

    /** `none` is answerable from the room snapshot alone, before the ladder has landed. */
    it('knows audio-only by name, without a ladder', () => {
        const audioOnly = {videoCeiling: {kind: 'ladder' as const, rung: AUDIO_ONLY_RUNG, rank: 0}};

        expect(isAudioOnlyRung(audioOnly.videoCeiling)).toBe(true);
        expect(videoCeilingOf(audioOnly, undefined)).toEqual({maxHeight: 0, maxFramerate: 0});
    });

    /** Edge: a rung this build has never heard of clamps nothing rather than guessing. */
    it('clamps nothing for a rung that is not on the ladder', () => {
        const future = {videoCeiling: {kind: 'ladder' as const, rung: '4k60', rank: 9}};

        expect(videoCeilingOf(future, LADDER)).toBeNull();
        expect(isAudioOnlyRung(future.videoCeiling)).toBe(false);
    });

    /** Negative: no limits block at all, which is what every older server sends. */
    it('clamps nothing when the room said nothing', () => {
        expect(videoCeilingOf(null, LADDER)).toBeNull();
        expect(videoCeilingOf({}, LADDER)).toBeNull();
        expect(videoCeilingOf(undefined, undefined)).toBeNull();
    });

    it('reads a rung name only off a ladder value', () => {
        expect(grantedRungName({kind: 'ladder', rung: '720p30', rank: 2})).toBe('720p30');
        expect(grantedRungName({kind: 'numeric', value: 2, unlimited: false})).toBeNull();
        expect(grantedRungName(null)).toBeNull();
    });
});

describe('slot counts', () => {
    it('pairs the ceiling with the count the room reports', () => {
        expect(publisherSlotsOf(CAPPED)).toEqual({used: 1, max: 2});
        expect(participantSlotsOf(CAPPED, 7)).toEqual({used: 7, max: 10});
    });

    /** Edge: half a sentence is not a denominator, so a ceiling with no count draws nothing. */
    it('draws nothing when only one half arrived', () => {
        expect(publisherSlotsOf({maxPublishers: {kind: 'numeric', value: 2, unlimited: false}}))
            .toBeNull();
        expect(publisherSlotsOf({publisherCount: 1})).toBeNull();
    });

    /** Negative: unlimited is not a number to put in a denominator. */
    it('draws nothing for an unlimited ceiling', () => {
        expect(publisherSlotsOf({
            maxPublishers: {kind: 'numeric', value: null, unlimited: true},
            publisherCount: 4,
        })).toBeNull();
        expect(participantSlotsOf({
            maxParticipants: {kind: 'numeric', value: null, unlimited: true},
        }, 4)).toBeNull();
    });

    /** A downgrade mid-call can leave more publishers in the room than the new plan allows. */
    it('counts over-capacity as full', () => {
        expect(isFull({used: 3, max: 2})).toBe(true);
        expect(isFull({used: 1, max: 2})).toBe(false);
        expect(isFull(null)).toBe(false);
    });
});

describe('whether video may start', () => {
    it('lets a publish through when the room has room for it', () => {
        expect(videoPublishBlock(CAPPED, false)).toBeNull();
    });

    it('names audio-only ahead of a full room, because it holds however empty the room is', () => {
        const audioOnlyAndFull: VoiceRoomLimitsDto = {
            videoCeiling: {kind: 'ladder', rung: AUDIO_ONLY_RUNG, rank: 0},
            maxPublishers: {kind: 'numeric', value: 2, unlimited: false},
            publisherCount: 2,
        };

        expect(videoPublishBlock(audioOnlyAndFull, false)).toBe('audio_only');
        expect(videoPublishBlock({...CAPPED, publisherCount: 2}, false)).toBe('publishers_full');
    });

    /** Stopping is never blocked. */
    it('never blocks a client that is already publishing', () => {
        const audioOnly: VoiceRoomLimitsDto = {
            videoCeiling: {kind: 'ladder', rung: AUDIO_ONLY_RUNG, rank: 0},
        };

        expect(videoPublishBlock(audioOnly, true)).toBeNull();
        expect(videoPublishBlock({...CAPPED, publisherCount: 2}, true)).toBeNull();
    });

    /** Negative: nothing said, nothing blocked. */
    it('blocks nothing when the room reported no limits', () => {
        expect(videoPublishBlock(null, false)).toBeNull();
        expect(videoPublishBlock({}, false)).toBeNull();
    });
});

describe('the sentences', () => {
    it('names what was reduced, per catalogue key', () => {
        expect(voiceSurfaceKey('voice.video_ceiling', {kind: 'ladder', rung: '720p30', rank: 2}))
            .toBe('VOICE.DEGRADED.QUALITY_CAPPED');
        expect(voiceSurfaceKey('voice.max_publishers', {kind: 'numeric', value: 2, unlimited: false}))
            .toBe('VOICE.DEGRADED.PUBLISHERS_FULL');
        expect(voiceSurfaceKey('voice.max_participants', null))
            .toBe('VOICE.DEGRADED.ROOM_AT_LIMIT');
    });

    /** "Capped at none" would be the one place naming the rung is actively wrong. */
    it('says audio-only rather than capped when the rung granted is none', () => {
        expect(voiceSurfaceKey('voice.video_ceiling', {kind: 'ladder', rung: AUDIO_ONLY_RUNG, rank: 0}))
            .toBe(VIDEO_BLOCK_KEYS.audio_only);
    });

    /** A key this build has never heard of gets no sentence rather than a raw code. */
    it('has nothing to say about a key it does not know, and does not invent one', () => {
        expect(voiceSurfaceKey('voice.future_thing', null)).toBeNull();
    });

    it('exports every literal key it can produce, so the i18n guard can reach them', () => {
        expect(VOICE_LIMIT_TRANSLATION_KEYS).toContain('VOICE.DEGRADED.AUDIO_ONLY');
        expect(VOICE_LIMIT_TRANSLATION_KEYS).toContain('VOICE.DEGRADED.QUALITY_CAPPED');
        expect(VOICE_LIMIT_TRANSLATION_KEYS).toContain('VOICE.DEGRADED.PUBLISHERS_FULL');
        expect(VOICE_LIMIT_TRANSLATION_KEYS).toContain('VOICE.DEGRADED.ROOM_AT_LIMIT');
        // Every entry is a literal, never a fragment something concatenates a code onto.
        for (const key of VOICE_LIMIT_TRANSLATION_KEYS) expect(key).toMatch(/^[A-Z][A-Z0-9_.]+$/);
    });
});
