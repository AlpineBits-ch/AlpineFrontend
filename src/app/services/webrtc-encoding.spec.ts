import {
    applyScreenEncoding,
    applySimpleBitrate,
    CAMERA_KBPS,
    cameraSendEncodings,
    screenSendEncodings,
    STREAM_AUDIO_KBPS,
    VIDEO_LAYER_RIDS,
    VOICE_AUDIO_KBPS,
    withStartBitrate,
} from './webrtc-encoding';

type FakeSender = RTCRtpSender & { setParameters: ReturnType<typeof vi.fn> };

function fakeSender(): FakeSender {
    const params = {encodings: [{}]} as RTCRtpSendParameters;
    return {
        getParameters: () => params,
        setParameters: vi.fn(async () => void 0),
        track: {contentHint: ''} as MediaStreamTrack,
    } as unknown as FakeSender;
}

/**
 * The content mode is the whole of what "Games" and "Text" mean on this path, so it is pinned as a
 * pair rather than as two independent settings: a hint without the matching degradation preference
 * is the configuration that produced the original "unsharp, slowly catches itself" complaint.
 */
describe('content mode', () => {
    it('asks for motion and holds framerate on a games share', async () => {
        const sender = fakeSender();
        await applyScreenEncoding(sender, {resolution: '1080p', framerate: 60, content: 'games'});
        expect(sender.track!.contentHint).toBe('motion');
        expect(sender.setParameters.mock.calls[0][0].degradationPreference).toBe('maintain-framerate');
    });

    it('asks for detail and holds resolution on a text share', async () => {
        const sender = fakeSender();
        await applyScreenEncoding(sender, {resolution: '1080p', framerate: 60, content: 'text'});
        expect(sender.track!.contentHint).toBe('detail');
        expect(sender.setParameters.mock.calls[0][0].degradationPreference).toBe('maintain-resolution');
    });

    /**
     * Rids are negotiated in the SDP and fixed at `addTransceiver` time, so a ladder that differed
     * by mode could not be toggled mid-stream without renegotiating. This is what makes the quality
     * bar's mode row free, and it fails the moment somebody restores rung `c` for games.
     */
    it('builds the same ladder in both modes, so the mode can change mid-stream', () => {
        const games = screenSendEncodings({resolution: '1080p', framerate: 30, content: 'games'});
        const text = screenSendEncodings({resolution: '1080p', framerate: 30, content: 'text'});
        expect(games).toEqual(text);
    });

    it('derives the same bitrate in both modes - mode is a policy axis, not a budget one', async () => {
        const games = fakeSender();
        const text = fakeSender();
        await applyScreenEncoding(games, {resolution: '1440p', framerate: 30, content: 'games'});
        await applyScreenEncoding(text, {resolution: '1440p', framerate: 30, content: 'text'});
        expect(games.setParameters.mock.calls[0][0].encodings[0].maxBitrate)
            .toBe(text.setParameters.mock.calls[0][0].encodings[0].maxBitrate);
        expect(games.setParameters.mock.calls[0][0].encodings[0].minBitrate)
            .toBe(text.setParameters.mock.calls[0][0].encodings[0].minBitrate);
    });
});

describe('applyScreenEncoding', () => {
    it('sets maintain-resolution degradation so the encoder drops frames, not pixels', async () => {
        const sender = fakeSender();
        await applyScreenEncoding(sender, {resolution: '1080p', framerate: 30, content: 'text'});
        expect(sender.setParameters.mock.calls[0][0].degradationPreference).toBe('maintain-resolution');
    });

    it('derives max and min bitrate and framerate from the preset', async () => {
        const sender = fakeSender();
        await applyScreenEncoding(sender, {resolution: '1080p', framerate: 60, content: 'text'});
        const encoding = sender.setParameters.mock.calls[0][0].encodings[0];
        expect(encoding.maxBitrate).toBe(8_000_000);
        expect(encoding.minBitrate).toBe(4_800_000);
        expect(encoding.maxFramerate).toBe(60);
        expect(encoding.scaleResolutionDownBy).toBe(1);
    });

    it('hints the track as detail so the encoder treats it as text, not motion', async () => {
        const sender = fakeSender();
        await applyScreenEncoding(sender, {resolution: '720p', framerate: 15, content: 'text'});
        expect(sender.track!.contentHint).toBe('detail');
    });

    it('survives a sender whose setParameters throws', async () => {
        const sender = {
            getParameters: () => ({encodings: [{}]}),
            setParameters: async () => {
                throw new Error('call ended');
            },
            track: null,
        } as unknown as RTCRtpSender;
        await expect(applyScreenEncoding(sender, {resolution: '720p', framerate: 30, content: 'text'})).resolves.toBeUndefined();
    });

    it('creates an encoding entry when the sender has none', async () => {
        const params = {} as RTCRtpSendParameters;
        const sender = {
            getParameters: () => params,
            setParameters: vi.fn(async () => void 0),
            track: null,
        } as unknown as FakeSender;
        await applyScreenEncoding(sender, {resolution: '720p', framerate: 30, content: 'text'});
        expect(sender.setParameters.mock.calls[0][0].encodings[0].maxBitrate).toBe(2_500_000);
    });
});

describe('applySimpleBitrate', () => {
    it('caps the sender without touching degradation preference', async () => {
        const sender = fakeSender();
        await applySimpleBitrate(sender, VOICE_AUDIO_KBPS);
        const applied = sender.setParameters.mock.calls[0][0];
        expect(applied.encodings[0].maxBitrate).toBe(64_000);
        expect(applied.degradationPreference).toBeUndefined();
    });

    it('ignores a null sender', async () => {
        await expect(applySimpleBitrate(null, 64)).resolves.toBeUndefined();
    });
});

describe('withStartBitrate', () => {
    it('adds a start bitrate to each video media section', () => {
        const sdp = ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 VP9/90000', ''].join('\r\n');
        expect(withStartBitrate(sdp, 4500)).toContain('a=fmtp:96 x-google-start-bitrate=4500');
    });

    it('leaves audio sections alone', () => {
        const sdp = [
            'm=audio 9 UDP/TLS/RTP/SAVPF 111',
            'a=rtpmap:111 opus/48000/2',
            'm=video 9 UDP/TLS/RTP/SAVPF 96',
            'a=rtpmap:96 VP9/90000',
            '',
        ].join('\r\n');
        const out = withStartBitrate(sdp, 4500);
        expect(out).not.toContain('a=fmtp:111 x-google-start-bitrate');
        expect(out).toContain('a=fmtp:96 x-google-start-bitrate=4500');
    });

    it('is a no-op on an sdp with no video', () => {
        expect(withStartBitrate('v=0\r\n', 4500)).toBe('v=0\r\n');
    });
});

describe('fixed audio and camera bitrates', () => {
    it('pins the rates that used to be user settings', () => {
        expect(VOICE_AUDIO_KBPS).toBe(64);
        expect(STREAM_AUDIO_KBPS).toBe(128);
        expect(CAMERA_KBPS).toBe(2500);
    });
});

/**
 * The rid spelling is the one thing in this file that fails silently. Nothing errors when the layers
 * are named wrong - the SFU simply degrades and falls back in the wrong direction, and the only
 * symptom is that the egress bill does not go down. Pinned here rather than described.
 */
describe('the simulcast ladder', () => {
    it('names the layers a, b, c - descending quality in ascending alphabetical order', () => {
        expect([...VIDEO_LAYER_RIDS]).toEqual(['a', 'b', 'c']);

        // The property the SFU actually relies on: `asciibetical` reads a-z as best-to-worst, so
        // sorting the rids must sort the layers from most to least desirable. `q`/`h`/`f` fails this.
        const byQuality = [...VIDEO_LAYER_RIDS];
        expect([...VIDEO_LAYER_RIDS].sort()).toEqual(byQuality);
    });

    it('scales the camera by 1, 2 and 4 with a bitrate ladder that is not linear in pixels', () => {
        const encodings = cameraSendEncodings(CAMERA_KBPS);
        expect(encodings.map(e => e.rid)).toEqual(['a', 'b', 'c']);
        expect(encodings.map(e => e.scaleResolutionDownBy)).toEqual([1, 2, 4]);
        expect(encodings.map(e => e.maxBitrate)).toEqual([2_500_000, 800_000, 250_000]);
    });

    it('gives a screen share two layers and no quarter-scale one', () => {
        const encodings = screenSendEncodings({resolution: '1080p', framerate: 30, content: 'text'});
        expect(encodings.map(e => e.rid)).toEqual(['a', 'b']);
        // 1440p/4 is 640x360, which is not a cheaper share but an unreadable one - see
        // screenSendEncodings. The saving that matters lands on `b`.
        expect(encodings.some(e => e.rid === 'c')).toBe(false);
        expect(encodings.map(e => e.maxBitrate)).toEqual([4_500_000, 1_440_000]);
    });
});

describe('encoding parameters on a simulcast sender', () => {
    function ladderSender(rids: string[]): FakeSender {
        const params = {encodings: rids.map(rid => ({rid}))} as RTCRtpSendParameters;
        return {
            getParameters: () => params,
            setParameters: vi.fn(async () => void 0),
            track: {contentHint: ''} as MediaStreamTrack,
        } as unknown as FakeSender;
    }

    it('applies the screen preset to every rung, not just the top one', async () => {
        const sender = ladderSender(['a', 'b']);
        await applyScreenEncoding(sender, {resolution: '1080p', framerate: 60, content: 'text'});
        const encodings = sender.setParameters.mock.calls[0][0].encodings;
        expect(encodings.map((e: RTCRtpEncodingParameters) => e.maxBitrate)).toEqual([8_000_000, 2_560_000]);
        expect(encodings.map((e: RTCRtpEncodingParameters) => e.scaleResolutionDownBy)).toEqual([1, 2]);
        expect(encodings.every((e: RTCRtpEncodingParameters) => e.maxFramerate === 60)).toBe(true);
    });

    it('floors only the top rung, so the ladder does not raise the rate the encoder insists on', async () => {
        const sender = ladderSender(['a', 'b']);
        await applyScreenEncoding(sender, {resolution: '1080p', framerate: 60, content: 'text'});
        const encodings = sender.setParameters.mock.calls[0][0].encodings;
        expect(encodings[0].minBitrate).toBe(4_800_000);
        expect(encodings[1].minBitrate).toBeUndefined();
    });

    it('scales a camera cap down the ladder rather than capping only the top layer', async () => {
        const sender = ladderSender(['a', 'b', 'c']);
        await applySimpleBitrate(sender, CAMERA_KBPS);
        const encodings = sender.setParameters.mock.calls[0][0].encodings;
        expect(encodings.map((e: RTCRtpEncodingParameters) => e.maxBitrate))
            .toEqual([2_500_000, 800_000, 250_000]);
    });

    it('treats an unnamed encoding as the top layer, so non-simulcast senders are unchanged', async () => {
        const sender = fakeSender();
        await applySimpleBitrate(sender, STREAM_AUDIO_KBPS);
        expect(sender.setParameters.mock.calls[0][0].encodings[0].maxBitrate).toBe(128_000);
    });
});
