import {
    applyScreenEncoding,
    applySimpleBitrate,
    CAMERA_KBPS,
    STREAM_AUDIO_KBPS,
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

describe('applyScreenEncoding', () => {
    it('sets maintain-resolution degradation so the encoder drops frames, not pixels', async () => {
        const sender = fakeSender();
        await applyScreenEncoding(sender, {resolution: '1080p', framerate: 30});
        expect(sender.setParameters.mock.calls[0][0].degradationPreference).toBe('maintain-resolution');
    });

    it('derives max and min bitrate and framerate from the preset', async () => {
        const sender = fakeSender();
        await applyScreenEncoding(sender, {resolution: '1080p', framerate: 60});
        const encoding = sender.setParameters.mock.calls[0][0].encodings[0];
        expect(encoding.maxBitrate).toBe(8_000_000);
        expect(encoding.minBitrate).toBe(4_800_000);
        expect(encoding.maxFramerate).toBe(60);
        expect(encoding.scaleResolutionDownBy).toBe(1);
    });

    it('hints the track as detail so the encoder treats it as text, not motion', async () => {
        const sender = fakeSender();
        await applyScreenEncoding(sender, {resolution: '720p', framerate: 15});
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
        await expect(applyScreenEncoding(sender, {resolution: '720p', framerate: 30})).resolves.toBeUndefined();
    });

    it('creates an encoding entry when the sender has none', async () => {
        const params = {} as RTCRtpSendParameters;
        const sender = {
            getParameters: () => params,
            setParameters: vi.fn(async () => void 0),
            track: null,
        } as unknown as FakeSender;
        await applyScreenEncoding(sender, {resolution: '720p', framerate: 30});
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
