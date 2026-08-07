/**
 * The recovery rules, which are the whole reason the unified voice backend exists.
 *
 * Every incident this mechanism replaces had the same shape: the state was fine, the announcement
 * was missed, and nothing ever repeated it. These tests pin the two branches that turn that into a
 * refetch - the gap and the instance change - and the two cases where the frontend guide's printed
 * rule would silently discard real events.
 */
import {describeTrack, VoiceRoomSnapshot, VoiceRoomTracker} from './voice-room';

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

    /**
     * Speaking and camera are relayed rather than stored, so the server never bumps the version for
     * them and they arrive carrying the one already held. Ignoring those drops every speaking
     * indicator in the app.
     */
    it('applies a relay event that carries the version already held', () => {
        const tracker = tracking('inst-1', 5);

        expect(tracker.receive({instanceId: 'inst-1', version: 5})).toBe('apply');
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
