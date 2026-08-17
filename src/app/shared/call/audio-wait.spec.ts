/**
 * A participant lands in `participantsWithAudio` only once their subscribe resolves, and that is
 * routinely a few seconds after they appear in the roster. These tests pin the split between that
 * loading window - where the UI says "connecting" and the call-wide banner stays quiet - and a
 * genuine fault, which only exists once the grace window has passed.
 */
import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';

import {AUDIO_GRACE_MS, trackAudioWait} from './audio-wait';
import {CallParticipant} from './call.types';

function participant(userId: string, isLocal = false): CallParticipant {
    return {
        userId,
        displayName: userId,
        avatarLabel: userId[0].toUpperCase(),
        isLocal,
        isMuted: false,
        isSpeaking: false,
        isCameraOn: false,
    };
}

function setup(initial: CallParticipant[] = [participant('remote')]) {
    TestBed.configureTestingModule({});
    const participants = signal<CallParticipant[]>(initial);
    const withAudio = signal<ReadonlySet<string>>(new Set<string>());
    const audio = TestBed.runInInjectionContext(() => trackAudioWait(participants, withAudio));
    TestBed.tick();
    return {participants, withAudio, audio};
}

describe('trackAudioWait', () => {
    beforeEach(() => {
        TestBed.resetTestingModule();
        vi.useFakeTimers();
    });

    afterEach(() => vi.useRealTimers());

    it('reports a participant without audio as connecting until the grace window passes', () => {
        const {audio} = setup();

        expect(audio.stateOf('remote')).toBe('connecting');
        expect(audio.anyStalled()).toBe(false);

        vi.advanceTimersByTime(AUDIO_GRACE_MS - 1);
        expect(audio.stateOf('remote')).toBe('connecting');

        vi.advanceTimersByTime(1);
        expect(audio.stateOf('remote')).toBe('stalled');
        expect(audio.anyStalled()).toBe(true);
    });

    it('never warns about a subscribe that lands inside the grace window', () => {
        const {withAudio, audio} = setup();

        vi.advanceTimersByTime(AUDIO_GRACE_MS - 1000);
        withAudio.set(new Set(['remote']));
        TestBed.tick();

        expect(audio.stateOf('remote')).toBe('ok');

        // The countdown has to be cancelled, not merely ignored - otherwise it fires a second later
        // and marks a participant we can already hear as broken.
        vi.advanceTimersByTime(AUDIO_GRACE_MS);
        expect(audio.stateOf('remote')).toBe('ok');
        expect(audio.anyStalled()).toBe(false);
    });

    it('clears the warning when audio finally arrives', () => {
        const {withAudio, audio} = setup();

        vi.advanceTimersByTime(AUDIO_GRACE_MS);
        expect(audio.stateOf('remote')).toBe('stalled');

        withAudio.set(new Set(['remote']));
        TestBed.tick();

        expect(audio.stateOf('remote')).toBe('ok');
        expect(audio.anyStalled()).toBe(false);
    });

    it('drops a stalled participant who leaves', () => {
        const {participants, audio} = setup();

        vi.advanceTimersByTime(AUDIO_GRACE_MS);
        expect(audio.anyStalled()).toBe(true);

        participants.set([]);
        TestBed.tick();

        expect(audio.anyStalled()).toBe(false);
        expect(audio.stateOf('remote')).toBe('ok');
    });

    it('ignores the local participant, who has no inbound audio by definition', () => {
        const {audio} = setup([participant('me', true)]);

        vi.advanceTimersByTime(AUDIO_GRACE_MS * 2);

        expect(audio.stateOf('me')).toBe('ok');
        expect(audio.anyStalled()).toBe(false);
    });

    it('runs a separate countdown per participant', () => {
        const {participants, audio} = setup([participant('early')]);

        vi.advanceTimersByTime(AUDIO_GRACE_MS - 2000);
        participants.set([participant('early'), participant('late')]);
        TestBed.tick();

        vi.advanceTimersByTime(2000);
        expect(audio.stateOf('early')).toBe('stalled');
        expect(audio.stateOf('late')).toBe('connecting');

        vi.advanceTimersByTime(AUDIO_GRACE_MS - 2000);
        expect(audio.stateOf('late')).toBe('stalled');
    });
});
