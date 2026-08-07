/**
 * The recovery rules, which are the whole reason the unified voice backend exists.
 *
 * Every incident this mechanism replaces had the same shape: the state was fine, the announcement
 * was missed, and nothing ever repeated it. These tests pin the two branches that turn that into a
 * refetch - the gap and the instance change - and the two cases where the frontend guide's printed
 * rule would silently discard real events.
 */
import {
    describeTrack,
    isStaleSubscription,
    VoiceRoomSnapshot,
    VoiceRoomTracker,
} from './voice-room';

function snapshot(instanceId: string, version: number): VoiceRoomSnapshot {
    return {roomId: 'chan-1', kind: 'channel', guildId: 'g', instanceId, version, participants: []};
}

function tracking(instanceId = 'inst-1', version = 5): VoiceRoomTracker {
    const tracker = new VoiceRoomTracker();
    tracker.applySnapshot(snapshot(instanceId, version));
    return tracker;
}

describe('VoiceRoomTracker', () => {
    it('applies the next event and advances', () => {
        const tracker = tracking('inst-1', 5);

        expect(tracker.receive({instanceId: 'inst-1', version: 6})).toBe('apply');
        expect(tracker.version).toBe(6);
    });

    /**
     * The server mutates the room once and then emits one TrackPublished per track, all reading the
     * same room version. Publishing a screen share with audio is exactly this: two events, one
     * version. The guide's `version <= held → ignore` discards the second, so every share would
     * arrive silent.
     */
    it('applies a repeated version, because batched announcements share one', () => {
        const tracker = tracking('inst-1', 5);

        expect(tracker.receive({instanceId: 'inst-1', version: 6})).toBe('apply');
        expect(tracker.receive({instanceId: 'inst-1', version: 6})).toBe('apply');
        expect(tracker.version).toBe(6);
    });

    it('applies a state event that carries the version already held', () => {
        const tracker = tracking('inst-1', 5);

        expect(tracker.receive({instanceId: 'inst-1', version: 5})).toBe('apply');
    });
});

describe('VoiceRoomTracker relay events', () => {
    it('applies a relay carrying the version already held', () => {
        expect(tracking('inst-1', 5).receiveRelay({instanceId: 'inst-1', version: 5})).toBe('apply');
    });

    /**
     * The failure this prevents: hold v5, miss the publish at v6, then a speaking relay arrives
     * carrying v6. Advanced like a state event that reads as the next in sequence, so the missed
     * publish is absorbed and the real v7 looks contiguous - the dropped event becomes permanent,
     * which is the exact thing the version mechanism exists to stop.
     */
    it('does not advance the version, so a missed state event is still detected', () => {
        const tracker = tracking('inst-1', 5);

        expect(tracker.receiveRelay({instanceId: 'inst-1', version: 6})).toBe('apply');
        expect(tracker.version).toBe(5);
        // The publish at v6 was never seen, and the next real event proves it.
        expect(tracker.receive({instanceId: 'inst-1', version: 7})).toBe('refetch');
    });

    /**
     * Speaking is written ten times a second. Gap-detecting on it means a room we cannot
     * resynchronise refetches at that rate; every other event finds the same gap at a sane one.
     */
    it('never reports a gap, however far ahead it is', () => {
        expect(tracking('inst-1', 5).receiveRelay({instanceId: 'inst-1', version: 99})).toBe('apply');
    });

    /** A rebuilt room invalidates everything held, relay or not. */
    it('still refetches when the room was rebuilt', () => {
        expect(tracking('inst-1', 5).receiveRelay({instanceId: 'inst-2', version: 5})).toBe('refetch');
    });

    it('ignores a genuinely older event', () => {
        const tracker = tracking('inst-1', 5);

        expect(tracker.receive({instanceId: 'inst-1', version: 4})).toBe('ignore');
        expect(tracker.version).toBe(5);
    });

    it('refetches on a gap, and does not advance past what it never saw', () => {
        const tracker = tracking('inst-1', 5);

        expect(tracker.receive({instanceId: 'inst-1', version: 7})).toBe('refetch');
        expect(tracker.version).toBe(5);
    });

    /**
     * The case a version counter cannot detect on its own. A room rebuilt after a Redis loss climbs
     * from zero, so it reaches numbers already seen behind a completely different roster - here the
     * version is exactly the one that would otherwise be applied.
     */
    it('refetches when the room was rebuilt, even though the version looks next', () => {
        const tracker = tracking('inst-1', 5);

        expect(tracker.receive({instanceId: 'inst-2', version: 6})).toBe('refetch');
    });

    it('refetches anything that arrives before the first snapshot', () => {
        expect(new VoiceRoomTracker().receive({instanceId: 'inst-1', version: 1})).toBe('refetch');
    });

    /**
     * The guild presence fan-out has not moved behind the announcer yet, so its events carry no
     * envelope. They cannot report a gap, but they still carry real state and dropping them would
     * empty the sidebar roster.
     */
    it('applies an event with no envelope rather than dropping it', () => {
        expect(tracking().receive({})).toBe('apply');
    });

    it('forgets the room on reset, so the next one does not inherit its counter', () => {
        const tracker = tracking('inst-1', 5);
        tracker.reset();

        expect(tracker.isTracking).toBe(false);
        expect(tracker.instanceId).toBeNull();
        expect(tracker.version).toBe(0);
        expect(tracker.receive({instanceId: 'inst-9', version: 1})).toBe('refetch');
    });
});

/**
 * The one failure that must not be retried. Getting this wrong in either direction is expensive:
 * missing it reproduces incident VNT-GE21R3P7's retry loop, and over-matching turns an unrelated
 * failure into a silent snapshot refetch that hides a real problem.
 */
describe('isStaleSubscription', () => {
    it('recognises the 409 the server answers', () => {
        expect(isStaleSubscription({
            status: 409,
            error: {error: 'staleSubscription', action: 'refetchSnapshot'},
        })).toBe(true);
    });

    /** Some hosts hand the body back as text rather than parsed JSON. */
    it('recognises it when the body arrives as a string', () => {
        expect(isStaleSubscription({
            status: 409,
            error: '{"error":"staleSubscription"}',
        })).toBe(true);
    });

    /** The Rust engine subscribes on our behalf and can only return a string. */
    it('recognises the marker the Rust engine returns', () => {
        expect(isStaleSubscription(
            'staleSubscription: https://api/voice/tracks returned 409 Conflict: {...}')).toBe(true);
    });

    it('does not match a 409 that means something else', () => {
        expect(isStaleSubscription({status: 409, error: {error: 'somethingElse'}})).toBe(false);
    });

    /**
     * A 502 is a real transport failure and gets backed-off retries. Treating it as stale would
     * replace a recoverable subscribe with a refetch that changes nothing.
     */
    it('does not match a 502', () => {
        expect(isStaleSubscription({status: 502, error: {error: 'staleSubscription'}})).toBe(false);
    });

    it('does not match arbitrary failures', () => {
        expect(isStaleSubscription(new Error('network down'))).toBe(false);
        expect(isStaleSubscription(null)).toBe(false);
        expect(isStaleSubscription(undefined)).toBe(false);
    });
});

describe('describeTrack', () => {
    /**
     * The ordering trap. `screen-audio-{id}` also satisfies `startsWith('screen-')`, so testing the
     * shorter prefix first reports a share's audio as the video of a share whose id is literally
     * `audio-{id}` - and clients subscribe to a track that does not exist.
     */
    it('reads screen audio as screen audio, not as the video of a share called audio-x', () => {
        expect(describeTrack('screen-audio-abc')).toEqual({
            trackName: 'screen-audio-abc', kind: 'screenAudio', shareId: 'abc',
        });
    });

    it('reads screen video', () => {
        expect(describeTrack('screen-abc')).toEqual({
            trackName: 'screen-abc', kind: 'screen', shareId: 'abc',
        });
    });

    it('reads the microphone', () => {
        expect(describeTrack('audio')).toEqual({trackName: 'audio', kind: 'audio', shareId: null});
    });

    /** Unrecognised names are cameras rather than errors - refusing to describe one drops it. */
    it('reads anything else as a camera', () => {
        expect(describeTrack('video')).toEqual({trackName: 'video', kind: 'video', shareId: null});
        expect(describeTrack('whatever')).toEqual({trackName: 'whatever', kind: 'video', shareId: null});
    });
});
