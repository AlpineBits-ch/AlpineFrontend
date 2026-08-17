import {
    describeTrack,
    isDeadMediaSession,
    isStaleSubscription,
    subscriptionSetOf,
    subscriptionSetOfEvent,
    subscriptionSetOfSnapshot,
    subscriptionSetSupersedes,
    VoiceResyncEvent,
    VoiceRoomSnapshot,
    VoiceRoomTracker,
    VoiceSubscriptionSet,
    VoiceSubscriptionsChangedEvent,
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

    it('does not advance the version, so a missed state event is still detected', () => {
        const tracker = tracking('inst-1', 5);

        expect(tracker.receiveRelay({instanceId: 'inst-1', version: 6})).toBe('apply');
        expect(tracker.version).toBe(5);
        // The publish at v6 was never seen, and the next real event proves it.
        expect(tracker.receive({instanceId: 'inst-1', version: 7})).toBe('refetch');
    });

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

    it('refetches when the room was rebuilt, even though the version looks next', () => {
        const tracker = tracking('inst-1', 5);

        expect(tracker.receive({instanceId: 'inst-2', version: 6})).toBe('refetch');
    });

    it('refetches anything that arrives before the first snapshot', () => {
        expect(new VoiceRoomTracker().receive({instanceId: 'inst-1', version: 1})).toBe('refetch');
    });

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

describe('isStaleSubscription', () => {
    it('recognises the 409 the server answers', () => {
        expect(
            isStaleSubscription({
                status: 409,
                error: {error: 'staleSubscription', action: 'refetchSnapshot'},
            }),
        ).toBe(true);
    });

    /** Some hosts hand the body back as text rather than parsed JSON. */
    it('recognises it when the body arrives as a string', () => {
        expect(
            isStaleSubscription({
                status: 409,
                error: '{"error":"staleSubscription"}',
            }),
        ).toBe(true);
    });

    /** The Rust engine subscribes on our behalf and can only return a string. */
    it('recognises the marker the Rust engine returns', () => {
        expect(
            isStaleSubscription('staleSubscription: https://api/voice/tracks returned 409 Conflict: {...}'),
        ).toBe(true);
    });

    it('does not match a 409 that means something else', () => {
        expect(isStaleSubscription({status: 409, error: {error: 'somethingElse'}})).toBe(false);
    });

    it('does not match a 502', () => {
        expect(isStaleSubscription({status: 502, error: {error: 'staleSubscription'}})).toBe(false);
    });

    it('does not match arbitrary failures', () => {
        expect(isStaleSubscription(new Error('network down'))).toBe(false);
        expect(isStaleSubscription(null)).toBe(false);
        expect(isStaleSubscription(undefined)).toBe(false);
    });
});

describe('isDeadMediaSession', () => {
    const sfuBody =
        '{"errorCode":"session_error","errorDescription":"Session appears to be ' +
        'disconnected. Please check if the PeerConnection is connected."}';

    /** The server's own classification, and the one the guide documents. */
    it('recognises the 409 the server answers', () => {
        expect(
            isDeadMediaSession({
                status: 409,
                error: {error: 'sessionGone', action: 'recreateSession'},
            }),
        ).toBe(true);
    });

    it('recognises the 502 the gateway relays from the SFU', () => {
        expect(
            isDeadMediaSession({
                status: 502,
                error: {operation: 'tracks/new', error: sfuBody},
            }),
        ).toBe(true);
    });

    it('recognises it when the body arrives as a string', () => {
        expect(isDeadMediaSession({status: 502, error: sfuBody})).toBe(true);
    });

    /** The Rust engine can only hand back a string. */
    it('recognises the marker in an engine error', () => {
        expect(isDeadMediaSession('tracks/new failed: session_error')).toBe(true);
    });

    it('does not match a stale subscription', () => {
        expect(
            isDeadMediaSession({
                status: 409,
                error: {error: 'staleSubscription', action: 'refetchSnapshot'},
            }),
        ).toBe(false);
    });

    it('is not confused with a stale subscription on the same status', () => {
        const stale = {status: 409, error: {error: 'staleSubscription', action: 'refetchSnapshot'}};
        const gone = {status: 409, error: {error: 'sessionGone', action: 'recreateSession'}};

        expect(isDeadMediaSession(stale)).toBe(false);
        expect(isStaleSubscription(gone)).toBe(false);
    });

    it('does not match a 502 that means something else', () => {
        expect(
            isDeadMediaSession({
                status: 502,
                error: {operation: 'tracks/new', error: '{"errorCode":"not_found_track_error"}'},
            }),
        ).toBe(false);
    });

    it('does not match arbitrary failures', () => {
        expect(isDeadMediaSession(new Error('network down'))).toBe(false);
        expect(isDeadMediaSession(null)).toBe(false);
        expect(isDeadMediaSession(undefined)).toBe(false);
    });
});

describe('describeTrack', () => {
    it('reads screen audio as screen audio, not as the video of a share called audio-x', () => {
        expect(describeTrack('screen-audio-abc')).toEqual({
            trackName: 'screen-audio-abc',
            kind: 'screenAudio',
            shareId: 'abc',
        });
    });

    it('reads screen video', () => {
        expect(describeTrack('screen-abc')).toEqual({
            trackName: 'screen-abc',
            kind: 'screen',
            shareId: 'abc',
        });
    });

    it('reads the microphone', () => {
        expect(describeTrack('audio')).toEqual({trackName: 'audio', kind: 'audio', shareId: null});
    });

    /** Unrecognised names are cameras rather than errors; refusing to describe one drops it. */
    it('reads anything else as a camera', () => {
        expect(describeTrack('video')).toEqual({trackName: 'video', kind: 'video', shareId: null});
        expect(describeTrack('whatever')).toEqual({trackName: 'whatever', kind: 'video', shareId: null});
    });
});

describe('subscriptionSetOf', () => {
    it('reads an empty tracks array as a real set that pulls nobody', () => {
        const set = subscriptionSetOf({
            mode: 'activeSpeaker',
            revision: 12,
            activeSpeakers: [],
            tracks: [],
        });

        expect(set).not.toBeNull();
        expect(set?.tracks).toEqual([]);
        expect(set?.mode).toBe('activeSpeaker');
        expect(set?.revision).toBe(12);
    });

    it('reads an absent tracks key as no set at all, not as an empty one', () => {
        expect(subscriptionSetOf({mode: 'all', revision: 0, activeSpeakers: []})).toBeNull();
    });

    it('reads a null tracks key as no set at all', () => {
        expect(subscriptionSetOf({mode: 'all', revision: 0, tracks: null})).toBeNull();
    });

    /** Nothing to read is the same statement as "no set in force", and must not be an empty one. */
    it('reads a missing block as no set', () => {
        expect(subscriptionSetOf(null)).toBeNull();
        expect(subscriptionSetOf(undefined)).toBeNull();
        expect(subscriptionSetOf('nonsense')).toBeNull();
    });

    it('keeps every field the subscriber needs to diff against what it holds', () => {
        const set = subscriptionSetOf({
            mode: 'activeSpeaker',
            revision: 3,
            activeSpeakers: ['u1'],
            tracks: [
                {
                    userId: 'u1',
                    mediaSessionId: 'sess-1',
                    trackName: 'audio',
                    kind: 'audio',
                    shareId: null,
                    layer: null,
                },
                {
                    userId: 'u2',
                    mediaSessionId: null,
                    trackName: 'screen-abc',
                    kind: 'screen',
                    shareId: 'abc',
                    layer: 'b',
                },
            ],
        });

        expect(set?.activeSpeakers).toEqual(['u1']);
        expect(set?.tracks).toEqual([
            {
                userId: 'u1',
                mediaSessionId: 'sess-1',
                trackName: 'audio',
                kind: 'audio',
                shareId: null,
                layer: null,
            },
            {
                userId: 'u2',
                mediaSessionId: null,
                trackName: 'screen-abc',
                kind: 'screen',
                shareId: 'abc',
                layer: 'b',
            },
        ]);
    });

    it('drops a layer spelling it does not recognise rather than passing it on', () => {
        const set = subscriptionSetOf({
            tracks: [{userId: 'u1', trackName: 'screen-abc', layer: 'Medium'}],
        });

        expect(set?.tracks[0]?.layer).toBeNull();
    });

    /** The name is the only thing the SFU stores, so it is also the fallback for the derived pair. */
    it('describes a track from its name when the wire omits kind and shareId', () => {
        const set = subscriptionSetOf({
            tracks: [{userId: 'u1', trackName: 'screen-audio-abc'}],
        });

        expect(set?.tracks[0]).toEqual({
            userId: 'u1',
            mediaSessionId: null,
            trackName: 'screen-audio-abc',
            kind: 'screenAudio',
            shareId: 'abc',
            layer: null,
        });
    });

    /** An entry with no name or no user cannot be pulled, and would sit in the diff forever. */
    it('drops an entry that names no track or no publisher', () => {
        const set = subscriptionSetOf({
            tracks: [{userId: 'u1'}, {trackName: 'audio'}, {userId: 'u2', trackName: 'audio'}],
        });

        expect(set?.tracks.map(track => track.userId)).toEqual(['u2']);
    });

    it('defaults mode, revision and activeSpeakers when the wire omits them', () => {
        const set = subscriptionSetOf({tracks: []});

        expect(set?.mode).toBe('all');
        expect(set?.revision).toBe(0);
        expect(set?.activeSpeakers).toEqual([]);
    });
});

describe('subscriptionSetOfSnapshot / subscriptionSetOfEvent', () => {
    const flatEvent = {
        channelId: 'chan-1',
        instanceId: 'inst-1',
        version: 42,
        mode: 'activeSpeaker',
        revision: 12,
        activeSpeakers: ['u1'],
        tracks: [{userId: 'u1', mediaSessionId: 'sess-1', trackName: 'audio'}],
    };

    it('reads the set the snapshot nests', () => {
        const set = subscriptionSetOfSnapshot({
            roomId: 'chan-1',
            subscriptions: {
                mode: 'activeSpeaker',
                revision: 12,
                tracks: [{userId: 'u1', trackName: 'audio'}],
            },
        });

        expect(set?.revision).toBe(12);
        expect(set?.tracks.map(track => track.trackName)).toEqual(['audio']);
    });

    /** The snapshot omits the block unless the plan is selective, and that means "pull everyone". */
    it('reads a snapshot with no subscriptions block as no set', () => {
        expect(subscriptionSetOfSnapshot({roomId: 'chan-1'})).toBeNull();
    });

    /** Nested and genuinely empty is still a real set: every tile collapsed, pull nobody. */
    it('reads a nested empty set as a real, empty set', () => {
        const set = subscriptionSetOfSnapshot({roomId: 'chan-1', subscriptions: {tracks: []}});

        expect(set).not.toBeNull();
        expect(set?.tracks).toEqual([]);
    });

    it('reads the set the event flattens onto the envelope', () => {
        const set = subscriptionSetOfEvent(flatEvent);

        expect(set?.mode).toBe('activeSpeaker');
        expect(set?.revision).toBe(12);
        expect(set?.activeSpeakers).toEqual(['u1']);
        expect(set?.tracks.map(track => track.userId)).toEqual(['u1']);
    });

    it('finds no set when an event is read as if it were nested, rather than an empty one', () => {
        expect(subscriptionSetOfSnapshot(flatEvent)).toBeNull();
        expect(subscriptionSetOfEvent(flatEvent)?.tracks).toHaveLength(1);
    });

    it('reads nothing at all as no set', () => {
        expect(subscriptionSetOfSnapshot(null)).toBeNull();
        expect(subscriptionSetOfEvent(undefined)).toBeNull();
    });
});

describe('subscriptionSetSupersedes', () => {
    function setAt(revision: number): VoiceSubscriptionSet {
        const parsed = subscriptionSetOf({revision, tracks: []});
        if (parsed === null) throw new Error('unreachable - tracks is present');
        return parsed;
    }

    it('applies the first set to arrive, whatever revision it carries', () => {
        expect(subscriptionSetSupersedes(setAt(7), null)).toBe(true);
        expect(subscriptionSetSupersedes(setAt(0), null)).toBe(true);
    });

    it('applies a higher revision', () => {
        expect(subscriptionSetSupersedes(setAt(13), setAt(12))).toBe(true);
    });

    it('applies an equal revision', () => {
        expect(subscriptionSetSupersedes(setAt(12), setAt(12))).toBe(true);
    });

    it('ignores a lower revision, because two server instances can interleave', () => {
        expect(subscriptionSetSupersedes(setAt(11), setAt(12))).toBe(false);
    });

    /** A caller holding only the number it last applied is the ordinary shape. */
    it('accepts a bare held revision', () => {
        expect(subscriptionSetSupersedes(setAt(12), {revision: 12})).toBe(true);
        expect(subscriptionSetSupersedes(setAt(11), {revision: 12})).toBe(false);
    });
});

describe('SubscriptionsChanged as a relay', () => {
    function changed(version: number): VoiceSubscriptionsChangedEvent {
        return {
            channelId: 'chan-1',
            instanceId: 'inst-1',
            version,
            mode: 'activeSpeaker',
            revision: 12,
            activeSpeakers: ['u1'],
            tracks: [],
        };
    }

    it('applies without advancing the held version', () => {
        const tracker = tracking('inst-1', 5);

        expect(tracker.receiveRelay(changed(6))).toBe('apply');
        expect(tracker.version).toBe(5);
        // The publish at v6 was never seen, and the next real event still proves it.
        expect(tracker.receive({instanceId: 'inst-1', version: 7})).toBe('refetch');
    });

    /** Active speakers turn over every few seconds; gap-detecting on that refetches at that rate. */
    it('never reports a gap, so a sentence does not read as a missed roster change', () => {
        expect(tracking('inst-1', 5).receiveRelay(changed(99))).toBe('apply');
    });

    /** A rebuilt room invalidates the held set along with everything else. */
    it('still refetches when the room was rebuilt', () => {
        expect(tracking('inst-1', 5).receiveRelay({...changed(5), instanceId: 'inst-2'})).toBe('refetch');
    });
});

describe('VoiceResyncReason', () => {
    it('names participantsEvicted, and it carries no delta', () => {
        const resync: VoiceResyncEvent = {
            reason: 'participantsEvicted',
            instanceId: 'inst-1',
            version: 6,
        };

        expect(resync.reason).toBe('participantsEvicted');
        expect(resync.userId).toBeUndefined();
    });
});
