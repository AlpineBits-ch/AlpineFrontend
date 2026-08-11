/**
 * The wire contract, pinned on the browser side.
 *
 * <p>Every assertion here has a twin in `src-tauri/src/media/publisher/signalling.rs`'s test module,
 * deliberately: those two clients publish into the same rooms, so a shape that drifts on one host is a
 * participant nobody on the other host can hear. The bodies are only ever validated by the real SFU,
 * which is the most expensive place to find out.</p>
 *
 * <p>The dialect split is the part worth this much attention. Sending Isle the neutral vocabulary is
 * rejected by a route that *exists*, so the failure reads like an auth problem rather than a contract
 * one - and sending the neutral surface `location` leaves its `direction` null and the track is dropped
 * with a 200 on the wire.</p>
 */
import {
    closeTracksBody,
    closeTracksMethod,
    closeTracksUrl,
    dialectFor,
    negotiateUrl,
    publishBody,
    sessionIdFrom,
    sessionUrl,
    subscribeBody,
    trackError,
    tracksUrl,
    voiceBase,
    VOICE_TRACK_NAME,
} from './voice-signalling';
import type {VoiceTarget} from '../ports/voice-publisher.port';

const API = 'https://api.example.test';
const guild: VoiceTarget = {kind: 'guild', guildId: 'g1', channelId: 'c1'};
const call: VoiceTarget = {kind: 'call', callId: 'call-1'};
const isle: VoiceTarget = {kind: 'isle'};
const offer = {type: 'offer', sdp: 'v=0'};

describe('dialects', () => {
    it('puts guild channels and calls on the neutral surface and Isle on Cloudflare\'s', () => {
        expect(dialectFor(guild)).toBe('neutral');
        expect(dialectFor(call)).toBe('neutral');
        expect(dialectFor(isle)).toBe('cloudflare');
    });
});

describe('routes', () => {
    it('matches the guild route the rest of the app uses', () => {
        // Must stay identical to GuildVoiceService.base() and Signalling::voice_base.
        expect(voiceBase(API, guild))
            .toBe('https://api.example.test/api/v1/guild/guilds/g1/channels/c1/voice');
    });

    it('keeps the messaging segment on the call route', () => {
        // The *gateway* path. YARP strips `messaging/` before the request reaches the controller, so
        // deriving this from the controller's own route produces a URL no gateway route matches - which
        // is how the DM path once 404'd without ever reaching the service.
        expect(voiceBase(API, call))
            .toBe('https://api.example.test/api/v1/messaging/voice/calls/call-1');
    });

    it('does not double a trailing slash on the api base', () => {
        for (const target of [guild, call, isle]) {
            expect(voiceBase(`${API}/`, target)).not.toContain('//api/v1');
            expect(sessionUrl(`${API}/`, target)).not.toContain('//api/');
        }
    });

    it('claims the participant audio session, because the microphone is what publishes it', () => {
        // primary=true is the difference between the room being told where our audio is and later
        // joiners subscribing to a session with no audio track on it.
        expect(sessionUrl(API, guild)).toBe(`${voiceBase(API, guild)}/session?primary=true`);
        expect(sessionUrl(API, call)).toBe(`${voiceBase(API, call)}/session?primary=true`);
    });

    it('opens the Isle session at cf/session, with no primary flag', () => {
        // A player has exactly one proximity session, so there is no primary concept - and the path
        // difference is not cosmetic: IsleVoiceApiService.createSession is the only route that answers.
        expect(sessionUrl(API, isle)).toBe(`${voiceBase(API, isle)}/cf/session`);
        expect(sessionUrl(API, isle)).not.toContain('primary');
    });

    it('has no cf segment on the neutral routes', () => {
        expect(tracksUrl(API, guild)).toBe(`${voiceBase(API, guild)}/tracks`);
        expect(negotiateUrl(API, guild)).toBe(`${voiceBase(API, guild)}/negotiate`);
        expect(closeTracksUrl(API, guild)).toBe(`${voiceBase(API, guild)}/tracks/close`);
        expect(tracksUrl(API, guild)).not.toContain('/cf/');
    });

    it('keeps the cf routes on Isle', () => {
        expect(tracksUrl(API, isle)).toBe(`${voiceBase(API, isle)}/cf/tracks/new`);
        expect(negotiateUrl(API, isle)).toBe(`${voiceBase(API, isle)}/cf/renegotiate`);
        expect(closeTracksUrl(API, isle)).toBe(`${voiceBase(API, isle)}/cf/tracks/close`);
    });

    it('closes tracks with the verb each surface takes', () => {
        // The one place the two dialects disagree on method rather than only on path.
        expect(closeTracksMethod('neutral')).toBe('post');
        expect(closeTracksMethod('cloudflare')).toBe('put');
    });
});

describe('a publish', () => {
    const tracks = [{mid: '0', trackName: VOICE_TRACK_NAME}];

    it('names the media session and says publish', () => {
        const body = publishBody('neutral', 'sess', offer, tracks);
        expect(body['mediaSessionId']).toBe('sess');
        expect(body['sessionDescription']).toEqual(offer);

        const track = (body['tracks'] as Record<string, unknown>[])[0];
        expect(track['direction']).toBe('publish');
        expect(track['mid']).toBe('0');
        expect(track['trackName']).toBe('audio');
        // The neutral surface deserialises `direction`; a stray `location` leaves it null.
        expect(track['location']).toBeUndefined();
    });

    it('still speaks the Cloudflare shape for Isle', () => {
        const body = publishBody('cloudflare', 'sess', offer, tracks);
        expect(body['cfSessionId']).toBe('sess');
        expect(body['mediaSessionId']).toBeUndefined();

        const track = (body['tracks'] as Record<string, unknown>[])[0];
        expect(track['location']).toBe('local');
        expect(track['direction']).toBeUndefined();
    });

    it('publishes under the name every other client resolves audio by', () => {
        // Other clients ask for this by string. Changing it orphans everyone on any other build.
        expect(VOICE_TRACK_NAME).toBe('audio');
    });
});

describe('a subscribe', () => {
    const tracks = [{trackName: 'audio', sessionId: 'their-session'}];

    it('names the publishing session and claims no mid', () => {
        const body = subscribeBody('neutral', 'mine', offer, tracks);
        expect(body['mediaSessionId']).toBe('mine');

        const track = (body['tracks'] as Record<string, unknown>[])[0];
        expect(track['direction']).toBe('subscribe');
        expect(track['trackName']).toBe('audio');
        expect(track['mediaSessionId']).toBe('their-session');
        // The SFU allocates the mid, and a subscribe that sends one is rejected.
        expect(track['mid']).toBeUndefined();
    });

    it('names the source session differently on Isle', () => {
        // The one field that changes name *and* nesting between the two: the session a track is pulled
        // from is `mediaSessionId` on the neutral surface and `sessionId` on Isle's, while the caller's
        // own session sits under the top-level key on both.
        const body = subscribeBody('cloudflare', 'mine', offer, tracks);
        expect(body['cfSessionId']).toBe('mine');

        const track = (body['tracks'] as Record<string, unknown>[])[0];
        expect(track['location']).toBe('remote');
        expect(track['sessionId']).toBe('their-session');
        expect(track['mediaSessionId']).toBeUndefined();
    });
});

describe('close tracks', () => {
    it('uses camel-case keys under whichever session name applies', () => {
        expect(closeTracksBody('neutral', 'sess', ['audio']))
            .toEqual({mediaSessionId: 'sess', trackNames: ['audio']});
        expect(closeTracksBody('cloudflare', 'sess', ['audio']))
            .toEqual({cfSessionId: 'sess', trackNames: ['audio']});
    });
});

describe('the session response', () => {
    it('reads the neutral shape', () => {
        expect(sessionIdFrom({mediaSessionId: 'abc', backend: 'cloudflare'})).toBe('abc');
    });

    it('still reads Isle\'s', () => {
        // Isle answers `{cfSessionId}` and no backend. One alias is cheaper than two response types
        // for a field that means the same thing on both.
        expect(sessionIdFrom({cfSessionId: 'abc'})).toBe('abc');
    });

    it('reports an absent id rather than inventing one', () => {
        expect(sessionIdFrom({})).toBeNull();
    });
});

describe('per-track failures', () => {
    it('finds one on a track that is not the first', () => {
        // A share with audio publishes two tracks at once, and a 200 whose *second* track failed is
        // exactly the shape that leaves a publisher inaudible while every layer reports success.
        expect(trackError([{mid: '0'}, {errorCode: 'not_found_track_error'}]))
            .toContain('not_found_track_error');
    });

    it('reads the error the Rust client reads, too', () => {
        expect(trackError([{error: 'session_error'}])).toContain('session_error');
    });

    it('says nothing when every track is fine', () => {
        expect(trackError([{mid: '0', trackName: 'audio'}])).toBeNull();
        expect(trackError(undefined)).toBeNull();
    });
});
