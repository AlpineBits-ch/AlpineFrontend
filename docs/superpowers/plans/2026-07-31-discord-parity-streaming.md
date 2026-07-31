# Discord-Parity Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give screen sharing Discord's quality model — resolution × framerate presets chosen at share time, frame-dropping degradation, fixed capture geometry — and replace the JPEG-over-IPC capture pipeline with a Rust-native H.264 publisher.

**Architecture:** A single `StreamPreset` (resolution + framerate) derives bitrate, replacing four user-facing bitrate dropdowns. Screen senders use `contentHint='detail'` + `degradationPreference='maintain-resolution'` so the encoder drops frames instead of pixels. Capture geometry is solved once at share start and never changes mid-session. Later phases move capture, encoding and RTP publishing entirely into Rust, publishing to Cloudflare Realtime through the backend endpoints that already exist.

**Tech Stack:** Angular 21 (signals, standalone components, OnPush), PrimeNG 21, Tailwind v4, Vitest via `@angular/build:unit-test`, Rust/Tauri 2, `xcap` (WGC capture), `webrtc-rs`, Windows Media Foundation, openh264.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-31-discord-parity-streaming-design.md`.
- Bitrate is **derived** from `StreamPreset`, never user-settable. No bitrate control may appear in settings UI.
- No simulcast, no per-viewer quality — out of scope by decision.
- Every resolution and framerate is available to every user; no tier gating.
- Tailwind tokens only: `bg-sidebar`, `bg-card`, `text-text-primary`, `border-border-subtle` etc. Never raw hex.
- Font sizes use rem-based Tailwind classes (`text-[0.625rem]`, not `text-[10px]`).
- Scrollbars use the `thin-scrollbar` class from `styles.css`; never inline `scrollbar-width` styles.
- PrimeNG buttons use `(onClick)`, not `(click)`.
- Run tests with `bun run ng test`. Run a type check with `bun run ng build --configuration development`.
- Commit after every task. Push to `main` directly.

---

### Task 1: Stream preset model

**Files:**
- Create: `src/app/models/stream-preset.ts`
- Test: `src/app/models/stream-preset.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `StreamResolution`, `StreamFramerate`, `StreamPreset`, `bitrateFor(preset): number`, `boxFor(resolution): [number, number] | null`, `RESOLUTION_LABELS`, `FRAMERATE_OPTIONS`, `DEFAULT_STREAM_PRESET`.

- [ ] **Step 1: Write the failing test**

```ts
// src/app/models/stream-preset.spec.ts
import {describe, expect, it} from 'vitest';
import {
    bitrateFor,
    boxFor,
    DEFAULT_STREAM_PRESET,
    FRAMERATE_OPTIONS,
    RESOLUTION_LABELS,
    StreamFramerate,
    StreamResolution,
} from './stream-preset';

describe('stream-preset', () => {
    it('derives the documented bitrate for every combination', () => {
        expect(bitrateFor({resolution: '720p', framerate: 15})).toBe(1500);
        expect(bitrateFor({resolution: '720p', framerate: 30})).toBe(2500);
        expect(bitrateFor({resolution: '720p', framerate: 60})).toBe(4000);
        expect(bitrateFor({resolution: '1080p', framerate: 15})).toBe(2500);
        expect(bitrateFor({resolution: '1080p', framerate: 30})).toBe(4500);
        expect(bitrateFor({resolution: '1080p', framerate: 60})).toBe(8000);
        expect(bitrateFor({resolution: '1440p', framerate: 15})).toBe(4000);
        expect(bitrateFor({resolution: '1440p', framerate: 30})).toBe(8000);
        expect(bitrateFor({resolution: '1440p', framerate: 60})).toBe(12000);
        expect(bitrateFor({resolution: 'source', framerate: 15})).toBe(6000);
        expect(bitrateFor({resolution: 'source', framerate: 30})).toBe(10000);
        expect(bitrateFor({resolution: 'source', framerate: 60})).toBe(18000);
    });

    it('resolves a bitrate for every declared resolution and framerate', () => {
        const resolutions: StreamResolution[] = ['720p', '1080p', '1440p', 'source'];
        for (const resolution of resolutions) {
            for (const framerate of FRAMERATE_OPTIONS) {
                expect(bitrateFor({resolution, framerate})).toBeGreaterThan(0);
            }
        }
    });

    it('maps resolutions to pixel boxes and source to null', () => {
        expect(boxFor('720p')).toEqual([1280, 720]);
        expect(boxFor('1080p')).toEqual([1920, 1080]);
        expect(boxFor('1440p')).toEqual([2560, 1440]);
        expect(boxFor('source')).toBeNull();
    });

    it('labels every resolution and offers the three Discord framerates', () => {
        expect(Object.keys(RESOLUTION_LABELS)).toEqual(['720p', '1080p', '1440p', 'source']);
        expect(FRAMERATE_OPTIONS).toEqual<StreamFramerate[]>([15, 30, 60]);
    });

    it('defaults to 1080p30', () => {
        expect(DEFAULT_STREAM_PRESET).toEqual({resolution: '1080p', framerate: 30});
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run ng test`
Expected: FAIL — cannot resolve `./stream-preset`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/app/models/stream-preset.ts

/** Output resolution for a screen share. 'source' keeps the source's own dimensions. */
export type StreamResolution = '720p' | '1080p' | '1440p' | 'source';

/** The three framerates Discord offers. */
export type StreamFramerate = 15 | 30 | 60;

/**
 * Resolution and framerate are chosen together, and bitrate is derived from the pair.
 *
 * Coupling them is what makes `degradationPreference: 'maintain-resolution'` safe: the encoder is
 * never asked to hold a high resolution on a bitrate budget picked for a lower one. Exposing
 * bitrate separately (as this app used to) let users starve the encoder into single-digit fps.
 */
export interface StreamPreset {
    resolution: StreamResolution;
    framerate: StreamFramerate;
}

const BITRATES: Record<StreamResolution, Record<StreamFramerate, number>> = {
    '720p': {15: 1500, 30: 2500, 60: 4000},
    '1080p': {15: 2500, 30: 4500, 60: 8000},
    '1440p': {15: 4000, 30: 8000, 60: 12000},
    source: {15: 6000, 30: 10000, 60: 18000},
};

const BOXES: Record<StreamResolution, [number, number] | null> = {
    '720p': [1280, 720],
    '1080p': [1920, 1080],
    '1440p': [2560, 1440],
    source: null,
};

export const RESOLUTION_LABELS: Record<StreamResolution, string> = {
    '720p': '720p',
    '1080p': '1080p',
    '1440p': '1440p',
    source: 'Source',
};

export const FRAMERATE_OPTIONS: StreamFramerate[] = [15, 30, 60];

export const DEFAULT_STREAM_PRESET: StreamPreset = {resolution: '1080p', framerate: 30};

/** Target bitrate in kbps for a preset. */
export function bitrateFor(preset: StreamPreset): number {
    return BITRATES[preset.resolution][preset.framerate];
}

/** The pixel box a resolution fits into, or null for 'source' (use the source's own size). */
export function boxFor(resolution: StreamResolution): [number, number] | null {
    return BOXES[resolution];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run ng test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/models/stream-preset.ts src/app/models/stream-preset.spec.ts
git commit -m "feat: add the stream preset contract"
```

---

### Task 2: Capture geometry solver

Solves the aspect-ratio breakage. Output dimensions are computed once from the source size and the
chosen resolution, then held fixed for the session.

**Files:**
- Create: `src/app/models/capture-geometry.ts`
- Test: `src/app/models/capture-geometry.spec.ts`

**Interfaces:**
- Consumes: `StreamResolution`, `boxFor` from Task 1.
- Produces: `CaptureGeometry { width: number; height: number }`, `solveGeometry(sourceW, sourceH, resolution): CaptureGeometry`.

- [ ] **Step 1: Write the failing test**

```ts
// src/app/models/capture-geometry.spec.ts
import {describe, expect, it} from 'vitest';
import {solveGeometry} from './capture-geometry';

describe('solveGeometry', () => {
    it('fits a 16:9 source into the target box exactly', () => {
        expect(solveGeometry(3840, 2160, '1080p')).toEqual({width: 1920, height: 1080});
    });

    it('preserves aspect ratio for an ultrawide source', () => {
        // 5120x1440 is 32:9. Fitting into 1920x1080 is width-bound: 1920x540.
        expect(solveGeometry(5120, 1440, '1080p')).toEqual({width: 1920, height: 540});
    });

    it('preserves aspect ratio for a portrait source', () => {
        // 1080x1920 is 9:16. Fitting into 1920x1080 is height-bound: 606x1080 -> even 606.
        expect(solveGeometry(1080, 1920, '1080p')).toEqual({width: 606, height: 1080});
    });

    it('never upscales a source smaller than the box', () => {
        expect(solveGeometry(1280, 720, '1440p')).toEqual({width: 1280, height: 720});
    });

    it('returns the source size for the source resolution', () => {
        expect(solveGeometry(2560, 1080, 'source')).toEqual({width: 2560, height: 1080});
    });

    it('rounds odd dimensions down to even ones', () => {
        // H.264 4:2:0 chroma subsampling requires even width and height.
        expect(solveGeometry(1287, 863, 'source')).toEqual({width: 1286, height: 862});
    });

    it('never returns a dimension below 2', () => {
        expect(solveGeometry(1, 1, 'source')).toEqual({width: 2, height: 2});
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run ng test`
Expected: FAIL — cannot resolve `./capture-geometry`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/app/models/capture-geometry.ts
import {boxFor, StreamResolution} from './stream-preset';

export interface CaptureGeometry {
    width: number;
    height: number;
}

/** Rounds down to an even number, with a floor of 2 (H.264 4:2:0 needs even dimensions). */
function toEven(value: number): number {
    return Math.max(2, Math.floor(value / 2) * 2);
}

/**
 * Decide the fixed output size for a capture session.
 *
 * Called once when sharing starts; the result must not change for the life of the session. A
 * mid-session change to the track's dimensions forces a renegotiation and a keyframe, which is what
 * used to make resizing a shared window tear the stream.
 */
export function solveGeometry(
    sourceWidth: number,
    sourceHeight: number,
    resolution: StreamResolution,
): CaptureGeometry {
    const box = boxFor(resolution);
    if (!box) return {width: toEven(sourceWidth), height: toEven(sourceHeight)};

    const [maxWidth, maxHeight] = box;
    // Never upscale: a 720p source shared at 1440p stays 720p.
    const scale = Math.min(maxWidth / sourceWidth, maxHeight / sourceHeight, 1);
    return {width: toEven(sourceWidth * scale), height: toEven(sourceHeight * scale)};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run ng test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/models/capture-geometry.ts src/app/models/capture-geometry.spec.ts
git commit -m "feat: solve capture geometry once per session"
```

---

### Task 3: Shared WebRTC encoding helpers

`voice-rtc.service.ts` and `call-webrtc.service.ts` each carry their own copy of the bitrate and
codec-preference logic, which is how the framerate-from-bitrate hack came to exist twice. Extract
the shared parts so this change is made once.

**Files:**
- Create: `src/app/services/webrtc-encoding.ts`
- Test: `src/app/services/webrtc-encoding.spec.ts`

**Interfaces:**
- Consumes: `StreamPreset`, `bitrateFor` from Task 1.
- Produces: `applyScreenEncoding(sender, preset)`, `applySimpleBitrate(sender, kbps)`, `preferVideoCodecs(transceiver, 'sender'|'receiver')`, `withStartBitrate(sdp, kbps)`, `VOICE_AUDIO_KBPS`, `STREAM_AUDIO_KBPS`.

- [ ] **Step 1: Write the failing test**

```ts
// src/app/services/webrtc-encoding.spec.ts
import {describe, expect, it, vi} from 'vitest';
import {applyScreenEncoding, STREAM_AUDIO_KBPS, VOICE_AUDIO_KBPS, withStartBitrate} from './webrtc-encoding';

function fakeSender() {
    const params: RTCRtpSendParameters = {encodings: [{}]} as RTCRtpSendParameters;
    return {
        getParameters: () => params,
        setParameters: vi.fn(async (p: RTCRtpSendParameters) => {
            Object.assign(params, p);
        }),
        track: {contentHint: ''} as unknown as MediaStreamTrack,
    } as unknown as RTCRtpSender & { setParameters: ReturnType<typeof vi.fn> };
}

describe('applyScreenEncoding', () => {
    it('sets maintain-resolution degradation so the encoder drops frames, not pixels', async () => {
        const sender = fakeSender();
        await applyScreenEncoding(sender, {resolution: '1080p', framerate: 30});
        const applied = sender.setParameters.mock.calls[0][0];
        expect(applied.degradationPreference).toBe('maintain-resolution');
    });

    it('derives max and min bitrate and framerate from the preset', async () => {
        const sender = fakeSender();
        await applyScreenEncoding(sender, {resolution: '1080p', framerate: 60});
        const encoding = sender.setParameters.mock.calls[0][0].encodings[0];
        expect(encoding.maxBitrate).toBe(8_000_000);
        expect(encoding.minBitrate).toBe(4_800_000); // 60% floor
        expect(encoding.maxFramerate).toBe(60);
        expect(encoding.scaleResolutionDownBy).toBe(1);
    });

    it("hints the track as detail so the encoder treats it as text, not motion", async () => {
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
});

describe('withStartBitrate', () => {
    it('adds a start bitrate to each video media section', () => {
        const sdp = [
            'v=0',
            'm=video 9 UDP/TLS/RTP/SAVPF 96',
            'a=rtpmap:96 VP9/90000',
            '',
        ].join('\r\n');
        const out = withStartBitrate(sdp, 4500);
        expect(out).toContain('a=fmtp:96 x-google-start-bitrate=4500');
    });

    it('leaves audio sections alone', () => {
        const sdp = ['m=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', ''].join('\r\n');
        expect(withStartBitrate(sdp, 4500)).not.toContain('x-google-start-bitrate');
    });

    it('is a no-op on an sdp with no video', () => {
        expect(withStartBitrate('v=0\r\n', 4500)).toBe('v=0\r\n');
    });
});

describe('audio bitrate constants', () => {
    it('pins voice and stream audio rather than exposing them as settings', () => {
        expect(VOICE_AUDIO_KBPS).toBe(64);
        expect(STREAM_AUDIO_KBPS).toBe(128);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run ng test`
Expected: FAIL — cannot resolve `./webrtc-encoding`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/app/services/webrtc-encoding.ts
import {bitrateFor, StreamPreset} from '../models/stream-preset';

/** Voice audio is fixed, matching Discord — bitrate there is a per-channel server setting. */
export const VOICE_AUDIO_KBPS = 64;
/** Screen-share audio is fixed stereo. */
export const STREAM_AUDIO_KBPS = 128;

/**
 * Fraction of the target bitrate used as the encoding floor.
 *
 * Without a floor, congestion control ramps from ~300 kbps and the first 15-30 s of every stream is
 * mush regardless of the cap — the "slowly catches itself" symptom.
 */
const MIN_BITRATE_RATIO = 0.6;

/**
 * Configure a screen-share sender from a preset.
 *
 * The two load-bearing settings are `contentHint = 'detail'` and
 * `degradationPreference = 'maintain-resolution'`: together they tell the encoder that this is text
 * and UI, and that under congestion it should drop frames rather than shed resolution. That is what
 * Discord does. The previous `'motion'` hint did the opposite and is why streams looked soft.
 */
export async function applyScreenEncoding(sender: RTCRtpSender, preset: StreamPreset): Promise<void> {
    if (sender.track) {
        try {
            sender.track.contentHint = 'detail';
        } catch { /* contentHint unsupported */
        }
    }
    const kbps = bitrateFor(preset);
    try {
        const params = sender.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        params.degradationPreference = 'maintain-resolution';
        params.encodings[0].maxBitrate = kbps * 1000;
        params.encodings[0].minBitrate = Math.round(kbps * MIN_BITRATE_RATIO) * 1000;
        params.encodings[0].maxFramerate = preset.framerate;
        params.encodings[0].scaleResolutionDownBy = 1;
        await sender.setParameters(params);
    } catch { /* setParameters unsupported, or the call already ended */
    }
}

/** Cap a non-screen sender (mic, camera) at a fixed bitrate. */
export async function applySimpleBitrate(sender: RTCRtpSender | null | undefined, kbps: number): Promise<void> {
    if (!sender) return;
    try {
        const params = sender.getParameters();
        if (!params.encodings?.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = kbps * 1000;
        await sender.setParameters(params);
    } catch { /* setParameters unsupported, or the call already ended */
    }
}

/** Prefer VP9, then H.264, for better quality-per-bit on screen content. */
export function preferVideoCodecs(transceiver: RTCRtpTransceiver, side: 'sender' | 'receiver'): void {
    const caps = (side === 'sender' ? RTCRtpSender : RTCRtpReceiver).getCapabilities('video')?.codecs ?? [];
    if (!caps.length) return;
    const ordered = [
        ...caps.filter(c => c.mimeType === 'video/VP9'),
        ...caps.filter(c => c.mimeType === 'video/H264'),
        ...caps.filter(c => c.mimeType !== 'video/VP9' && c.mimeType !== 'video/H264'),
    ];
    try {
        transceiver.setCodecPreferences(ordered);
    } catch { /* codec preferences unsupported */
    }
}

/**
 * Munge `x-google-start-bitrate` into every video media section of an offer.
 *
 * `minBitrate` alone is not honoured until the first bandwidth estimate arrives; the start bitrate
 * is what stops the stream opening at a few hundred kbps.
 */
export function withStartBitrate(sdp: string, kbps: number): string {
    const lines = sdp.split(/\r\n|\n/);
    const out: string[] = [];
    let inVideo = false;

    for (const line of lines) {
        if (line.startsWith('m=')) inVideo = line.startsWith('m=video');
        out.push(line);
        if (!inVideo) continue;
        const match = /^a=rtpmap:(\d+) /.exec(line);
        if (match) out.push(`a=fmtp:${match[1]} x-google-start-bitrate=${kbps}`);
    }
    return out.join('\r\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run ng test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/webrtc-encoding.ts src/app/services/webrtc-encoding.spec.ts
git commit -m "feat: share screen encoding policy between both call paths"
```

---

### Task 4: Fixed-geometry capture

**Files:**
- Modify: `src/app/services/rust-media.service.ts` (remove `StreamResolution`/`RESOLUTION_DIMS`, rewrite `startScreenCapture`, replace `setScreenResolution`)
- Modify: `src-tauri/src/media/screen.rs` (replace `set_screen_capture_resolution` with `set_screen_capture_geometry`, letterbox into the fixed frame)
- Modify: `src-tauri/src/lib.rs` (command registration)

**Interfaces:**
- Consumes: `solveGeometry` (Task 2), `StreamPreset` (Task 1).
- Produces: `RustMediaService.startScreenCapture(sourceId, geometry: CaptureGeometry, fps: number): Promise<MediaStreamTrack>`, `RustMediaService.setCaptureFps(fps)`, `RustMediaService.setCaptureGeometry(geometry)`.

- [ ] **Step 1: Replace the resolution model in `rust-media.service.ts`**

Delete `StreamResolution`, `RESOLUTION_DIMS`, `_captureResolution`, `captureResolution` and
`setScreenResolution`. Replace the top of `startScreenCapture` so the canvas is created at the
solved size and never resized:

```ts
async startScreenCapture(sourceId: string, geometry: CaptureGeometry, fps = 30): Promise<MediaStreamTrack> {
    await this.stopScreenCapture();

    this._captureFps.set(fps);
    this._captureGeometry.set(geometry);
    this.inboundFrameCount = 0;
    this.renderedFrameCount = 0;
    this.fpsInterval = setInterval(() => {
        this._inboundFps.set(this.inboundFrameCount);
        this._renderedFps.set(this.renderedFrameCount);
        this.inboundFrameCount = 0;
        this.renderedFrameCount = 0;
    }, 1000);

    // Sized once, from the solved geometry. Resizing a canvas that captureStream() is already
    // attached to changes the track's dimensions mid-session, forcing a renegotiation and a
    // keyframe — which is what used to tear the stream when a shared window was resized.
    const canvas = document.createElement('canvas');
    canvas.width = geometry.width;
    canvas.height = geometry.height;
    const ctx = canvas.getContext('2d')!;
    this.screenCanvas = canvas;
    this.screenCtx = ctx;
    // ... rest unchanged: captureStream(0), channel wiring ...

    await invoke('set_screen_capture_geometry', {width: geometry.width, height: geometry.height}).catch(() => {});
    await invoke('start_screen_capture', {sourceId, fps, onFrame: channel});

    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error('No video track from canvas');
    // 'detail' — screen content is text and UI. Combined with maintain-resolution degradation on
    // the sender, the encoder drops frames under congestion instead of shedding resolution.
    try {
        (track as { contentHint?: string }).contentHint = 'detail';
    } catch { /* contentHint unsupported */
    }
    return track;
}
```

Add the geometry signal alongside the existing fps signals:

```ts
private readonly _captureGeometry = signal<CaptureGeometry>({width: 1920, height: 1080});
readonly captureGeometry = this._captureGeometry.asReadonly();

/** Change the fixed output size. Triggers one deliberate renegotiation upstream. */
async setCaptureGeometry(geometry: CaptureGeometry): Promise<void> {
    this._captureGeometry.set(geometry);
    if (this.screenCanvas) {
        this.screenCanvas.width = geometry.width;
        this.screenCanvas.height = geometry.height;
    }
    if (!isTauri()) return;
    await invoke('set_screen_capture_geometry', {width: geometry.width, height: geometry.height}).catch(() => {});
}
```

- [ ] **Step 2: Stop resizing the canvas per frame**

In `decodeNextFrame`, replace the `c.width !== bitmap.width` block with a letterboxing draw that
keeps the canvas at its fixed size:

```ts
const c = this.screenCanvas as HTMLCanvasElement;
const ctx = this.screenCtx as CanvasRenderingContext2D;
// The canvas size is fixed for the session. A source whose own aspect ratio drifts (a window being
// resized) is letterboxed into the fixed frame rather than changing the track's dimensions.
const scale = Math.min(c.width / bitmap.width, c.height / bitmap.height);
const dw = bitmap.width * scale;
const dh = bitmap.height * scale;
const dx = (c.width - dw) / 2;
const dy = (c.height - dh) / 2;
if (dw !== c.width || dh !== c.height) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);
}
ctx.drawImage(bitmap, dx, dy, dw, dh);
```

- [ ] **Step 3: Replace the Rust resolution command**

In `src-tauri/src/media/screen.rs`, rename `set_screen_capture_resolution` to
`set_screen_capture_geometry` and drop the independent per-axis clamp that broke ultrawides:

```rust
/// Set the fixed output size for the encode thread.
///
/// The frontend solves this once per session from the source dimensions and the chosen resolution
/// preset, so the value already preserves the source's aspect ratio. Clamping each axis
/// independently (as the old command did) silently changed the aspect ratio of ultrawide sources.
#[tauri::command]
pub fn set_screen_capture_geometry(
    width: u32,
    height: u32,
    state: tauri::State<'_, ScreenCaptureState>,
) {
    state.max_w.store(width.clamp(2, 7680), Ordering::Relaxed);
    state.max_h.store(height.clamp(2, 4320), Ordering::Relaxed);
}
```

Update the registration in `src-tauri/src/lib.rs`: replace
`media::screen::set_screen_capture_resolution` with `media::screen::set_screen_capture_geometry`.

- [ ] **Step 4: Verify the build compiles**

Run: `bun run ng build --configuration development`
Expected: success. Any remaining reference to `setScreenResolution` or `StreamResolution` imported
from `rust-media.service` is a compile error to fix — the canonical `StreamResolution` now lives in
`models/stream-preset.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/rust-media.service.ts src-tauri/src/media/screen.rs src-tauri/src/lib.rs
git commit -m "fix: hold screen capture geometry fixed for the session"
```

---

### Task 5: Preset-driven publishing in `voice-rtc.service.ts`

**Files:**
- Modify: `src/app/services/voice-rtc.service.ts`

**Interfaces:**
- Consumes: `applyScreenEncoding`, `applySimpleBitrate`, `preferVideoCodecs`, `withStartBitrate`, `VOICE_AUDIO_KBPS`, `STREAM_AUDIO_KBPS` (Task 3); `solveGeometry` (Task 2); the picker result shape from Task 9.
- Produces: `publishScreen(guildId, channelId)` unchanged in signature; new `setScreenPreset(preset): Promise<void>`.

- [ ] **Step 1: Replace the settings effect**

The constructor effect currently re-applies four user bitrates. Bitrates are no longer settings, so
it goes entirely. Delete the whole `effect(...)` block in the constructor.

- [ ] **Step 2: Rewrite `publishScreen` to use the picker's preset**

```ts
async publishScreen(guildId: string, channelId: string): Promise<{ shareId: string } | null> {
    if (!this.pc || !this.cfSessionId) return null;

    try {
        const choice = await this.screenPicker.show();
        if (!choice) return null;
        const {sourceId, preset, shareAudio, sourceWidth, sourceHeight} = choice;

        const geometry = solveGeometry(sourceWidth, sourceHeight, preset.resolution);
        this.screenPreset = preset;
        const videoTrack = await this.rustMedia.startScreenCapture(sourceId, geometry, preset.framerate);
        this.localScreenTrack = videoTrack;
        this.localScreenStream.set(new MediaStream([videoTrack]));

        let audioTrack: MediaStreamTrack | null = null;
        if (shareAudio) {
            try {
                audioTrack = await this.rustMedia.startLoopbackCapture();
            } catch {
                console.warn('[ScreenShare] Loopback audio unavailable');
            }
        }
        // ... unchanged through to the negotiation block ...
```

Inside the negotiation block, replace the codec-preference stanza with `preferVideoCodecs(...)` and
the trailing bitrate calls:

```ts
        const videoTransceiver = this.pc.getTransceivers().find(t => t.sender === videoSender);
        if (videoTransceiver) preferVideoCodecs(videoTransceiver, 'sender');

        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription({
            type: offer.type,
            sdp: withStartBitrate(offer.sdp ?? '', bitrateFor(preset)),
        });
        // ...
        await applyScreenEncoding(videoSender, preset);
        this.localSenders.set('screenVideo', videoSender);
        if (audioSender) {
            await applySimpleBitrate(audioSender, STREAM_AUDIO_KBPS);
            this.localSenders.set('screenAudio', audioSender);
        }
```

Add the field and the mid-stream setter:

```ts
private screenPreset: StreamPreset = DEFAULT_STREAM_PRESET;

/** Change quality mid-stream. Framerate applies within a frame; resolution renegotiates once. */
async setScreenPreset(preset: StreamPreset): Promise<void> {
    const previous = this.screenPreset;
    this.screenPreset = preset;
    if (preset.framerate !== previous.framerate) await this.rustMedia.setCaptureFps(preset.framerate);
    if (preset.resolution !== previous.resolution) {
        const {width, height} = this.rustMedia.captureGeometry();
        const solved = solveGeometry(width, height, preset.resolution);
        await this.rustMedia.setCaptureGeometry(solved);
    }
    const sender = this.localSenders.get('screenVideo');
    if (sender) await applyScreenEncoding(sender, preset);
}
```

- [ ] **Step 3: Replace the remaining bitrate call sites**

- `connect()`: `await this.applyBitrate(sender, this.audioSettings.settings().audioBitrate)` becomes
  `await applySimpleBitrate(sender, VOICE_AUDIO_KBPS)`.
- `publishCamera()`: `await this.applyBitrate(sender, ...videoBitrate)` becomes
  `await applySimpleBitrate(sender, CAMERA_KBPS)` where
  `const CAMERA_KBPS = 2500;` is a module constant in `voice-rtc.service.ts`.
- `subscribeVideo()`: replace the inline codec-ordering block with `preferVideoCodecs(transceiver, 'receiver')`.
- Delete the now-unused private `applyBitrate` method.

- [ ] **Step 4: Fix `publishCamera` ignoring the selected camera**

```ts
const stream = await navigator.mediaDevices.getUserMedia({
    video: await this.audioSettings.buildVideoConstraint(),
    audio: false,
});
```

- [ ] **Step 5: Verify the build compiles**

Run: `bun run ng build --configuration development`
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add src/app/services/voice-rtc.service.ts
git commit -m "feat: publish guild screen shares from a stream preset"
```

---

### Task 6: Preset-driven publishing in `call-webrtc.service.ts`

**Files:**
- Modify: `src/app/services/call-webrtc.service.ts`

**Interfaces:**
- Consumes: everything Task 3 produces; `StreamPreset` from Task 1.
- Produces: `setScreenPreset(preset): Promise<void>` on `CallWebRtcService`.

- [ ] **Step 1: Delete the bitrate effect**

Remove the constructor `effect` that re-applies `audioBitrate`, `videoBitrate` and
`screenVideoBitrate` (`call-webrtc.service.ts:114-119`).

- [ ] **Step 2: Rewrite `publishScreenTrack`**

```ts
private async publishScreenTrack(shareId: string, stream: MediaStream): Promise<void> {
    if (!this.pc || !this.callId) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    const transceiver = this.pc.addTransceiver(track, {direction: 'sendonly'});
    preferVideoCodecs(transceiver, 'sender');

    const cfTrackName = `screen-${shareId}`;
    const results = await this.offerAnswerCycle(() => [{
        location: 'local',
        mid: transceiver.mid ?? '0',
        trackName: cfTrackName,
    }]);
    this.screenSender = transceiver.sender;
    this.screenTrackName = results[0]?.trackName ?? cfTrackName;
    this.screenShareId = shareId;
    await applyScreenEncoding(transceiver.sender, this.screenPreset);
    if (this.callId) this.voiceWs.invokeScreenShareStarted(this.callId, shareId, this.screenTrackName);
}
```

Add the field and setter, mirroring Task 5:

```ts
private screenPreset: StreamPreset = DEFAULT_STREAM_PRESET;

async setScreenPreset(preset: StreamPreset): Promise<void> {
    this.screenPreset = preset;
    if (this.screenSender) await applyScreenEncoding(this.screenSender, preset);
}
```

The preset arrives via `CallSessionService`'s local share state, which Task 9 extends to carry it.

- [ ] **Step 3: Replace the remaining bitrate call sites**

- `publishAudioTrack`: `applySimpleBitrate(transceiver.sender, VOICE_AUDIO_KBPS)`.
- `publishVideoTrack`: `applySimpleBitrate(transceiver.sender, CAMERA_KBPS)` with the same
  `const CAMERA_KBPS = 2500;` module constant.
- Receive-side codec block: `preferVideoCodecs(transceiver, 'receiver')`.
- Delete the private `applyBitrate` method.

- [ ] **Step 4: Verify the build compiles**

Run: `bun run ng build --configuration development`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/call-webrtc.service.ts
git commit -m "feat: publish DM call screen shares from a stream preset"
```

---

### Task 7: Settings model migration

**Files:**
- Modify: `src/app/services/audio-settings.service.ts`
- Test: `src/app/services/audio-settings.service.spec.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `AudioSettings` without the four bitrate keys, with `noiseSuppressionMode: 'none' | 'standard' | 'enhanced'`, `inputVolume: number`, `outputVolume: number`.

- [ ] **Step 1: Write the failing test**

```ts
// src/app/services/audio-settings.service.spec.ts
import {TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it} from 'vitest';
import {AudioSettingsService} from './audio-settings.service';

const KEY = 'alpine_audio_settings';

function load(): AudioSettingsService {
    TestBed.resetTestingModule();
    return TestBed.inject(AudioSettingsService);
}

describe('AudioSettingsService migration', () => {
    beforeEach(() => localStorage.clear());

    it('drops the removed bitrate keys', () => {
        localStorage.setItem(KEY, JSON.stringify({
            audioBitrate: 320, screenAudioBitrate: 510, videoBitrate: 8000, screenVideoBitrate: 15000,
        }));
        const settings = load().settings() as Record<string, unknown>;
        expect(settings['audioBitrate']).toBeUndefined();
        expect(settings['screenAudioBitrate']).toBeUndefined();
        expect(settings['videoBitrate']).toBeUndefined();
        expect(settings['screenVideoBitrate']).toBeUndefined();
    });

    it('folds the enhanced toggle into the enhanced mode', () => {
        localStorage.setItem(KEY, JSON.stringify({noiseSuppression: true, enhancedNoiseSuppression: true}));
        expect(load().settings().noiseSuppressionMode).toBe('enhanced');
    });

    it('folds a plain noise-suppression toggle into the standard mode', () => {
        localStorage.setItem(KEY, JSON.stringify({noiseSuppression: true, enhancedNoiseSuppression: false}));
        expect(load().settings().noiseSuppressionMode).toBe('standard');
    });

    it('folds both toggles off into the none mode', () => {
        localStorage.setItem(KEY, JSON.stringify({noiseSuppression: false, enhancedNoiseSuppression: false}));
        expect(load().settings().noiseSuppressionMode).toBe('none');
    });

    it('defaults the new volume keys to 100', () => {
        localStorage.setItem(KEY, JSON.stringify({micId: 'mic-1'}));
        const settings = load().settings();
        expect(settings.inputVolume).toBe(100);
        expect(settings.outputVolume).toBe(100);
    });

    it('is idempotent across a save and a reload', () => {
        localStorage.setItem(KEY, JSON.stringify({noiseSuppression: true, enhancedNoiseSuppression: true}));
        const first = load();
        first.update({micId: 'mic-2'});
        const second = load().settings();
        expect(second.noiseSuppressionMode).toBe('enhanced');
        expect(second.micId).toBe('mic-2');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run ng test`
Expected: FAIL — `noiseSuppressionMode` does not exist.

- [ ] **Step 3: Write the implementation**

In `AudioSettings`, delete `audioBitrate`, `screenAudioBitrate`, `videoBitrate`,
`screenVideoBitrate`, `noiseSuppression` and `enhancedNoiseSuppression`. Add:

```ts
/** Mirrors Discord's None / Standard / Krisp. 'enhanced' is the Rust RNNoise pipeline. */
noiseSuppressionMode: 'none' | 'standard' | 'enhanced';
/** Microphone input gain, 0-100. */
inputVolume: number;
/** Output volume applied to remote audio elements, 0-100. */
outputVolume: number;
```

Update `DEFAULTS` accordingly (`noiseSuppressionMode: 'standard'`, `inputVolume: 100`,
`outputVolume: 100`) and rewrite `load()`:

```ts
private load(): AudioSettings {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {...DEFAULTS};
        return migrate(JSON.parse(raw) as Record<string, unknown>);
    } catch {
        return {...DEFAULTS};
    }
}
```

```ts
/** Removed keys from before the stream-preset rework; dropped on load. */
const DROPPED_KEYS = ['audioBitrate', 'screenAudioBitrate', 'videoBitrate', 'screenVideoBitrate'];

/**
 * Fold a persisted settings blob onto the current shape.
 *
 * Runs on every construction, so it must be idempotent: a blob that has already been migrated
 * carries `noiseSuppressionMode` and no legacy toggles, and must survive unchanged.
 */
function migrate(stored: Record<string, unknown>): AudioSettings {
    const next: Record<string, unknown> = {...DEFAULTS, ...stored};

    if (next['noiseSuppressionMode'] === undefined) {
        next['noiseSuppressionMode'] = stored['enhancedNoiseSuppression'] === true
            ? 'enhanced'
            : stored['noiseSuppression'] === false ? 'none' : 'standard';
    }

    for (const key of [...DROPPED_KEYS, 'noiseSuppression', 'enhancedNoiseSuppression']) delete next[key];
    return next as unknown as AudioSettings;
}
```

Update `buildAudioConstraint` to read the new mode:

```ts
const mode = s.noiseSuppressionMode;
return {
    deviceId: deviceId ? {ideal: deviceId} : undefined,
    noiseSuppression: mode === 'standard',
    echoCancellation: s.echoCancellation,
    autoGainControl: s.autoGainControl,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run ng test`
Expected: PASS.

- [ ] **Step 5: Fix the consumers**

`voice-rtc.service.ts` reads `s.enhancedNoiseSuppression` and `s.noiseSuppression` when deciding the
audio path. Replace with:

```ts
const useRust = s.noiseSuppressionMode === 'enhanced' || await this.rustMedia.shouldUseRustAudio();
// ...
audioTrack = await this.rustMedia.startMicCapture({
    deviceId: s.micId === 'default' ? null : s.micId,
    noiseSuppression: s.noiseSuppressionMode !== 'none',
    autoGainControl: s.autoGainControl,
    vadThreshold: s.vadStrength,
});
```

Apply the same substitution anywhere else `grep -rn "enhancedNoiseSuppression\|\.noiseSuppression\b" src/app` reports.

- [ ] **Step 6: Commit**

```bash
git add src/app/services/audio-settings.service.ts src/app/services/audio-settings.service.spec.ts src/app/services/voice-rtc.service.ts
git commit -m "feat: migrate audio settings off per-stream bitrates"
```

---

### Task 8: Settings page rewrite

**Files:**
- Modify: `src/app/features/settings/settings-modal/pages/voice-video-settings/voice-video-settings.component.html`
- Modify: `src/app/features/settings/settings-modal/pages/voice-video-settings/voice-video-settings.component.ts`

**Interfaces:**
- Consumes: `AudioSettings` from Task 7.
- Produces: no exported API change.

- [ ] **Step 1: Delete the Streaming Quality section**

Remove the entire `<!-- ── Streaming Quality ── -->` section from the template
(`voice-video-settings.component.html:236-270`), and from the component delete
`audioBitrateOptions`, `screenAudioBitrateOptions`, `videoBitrateOptions`,
`screenVideoBitrateOptions`, the `BitrateOption` interface, and the four accessor pairs.

- [ ] **Step 2: Add the volume sliders**

Under the Input Device select:

```html
<div class="flex flex-col gap-2">
    <div class="flex items-center justify-between">
        <label class="text-xs font-medium text-white/45 uppercase tracking-wide">Input Volume</label>
        <span class="text-xs text-white/40 tabular-nums">{{ inputVolume }}%</span>
    </div>
    <p-slider [(ngModel)]="inputVolume" [max]="100" [min]="0" styleClass="w-full"/>
</div>
```

The same block under the Output Device select, bound to `outputVolume`. Add the accessors:

```ts
get inputVolume(): number {
    return this.audioSettings.settings().inputVolume;
}

set inputVolume(v: number) {
    this.audioSettings.update({inputVolume: v});
}

get outputVolume(): number {
    return this.audioSettings.settings().outputVolume;
}

set outputVolume(v: number) {
    this.audioSettings.update({outputVolume: v});
}
```

- [ ] **Step 3: Replace the two noise-suppression toggles with one select**

Delete the "Noise Suppression" toggle row and the whole "Enhanced Noise Suppression" block. In the
Voice Processing section put:

```html
<div class="flex flex-col gap-1.5">
    <label class="text-xs font-medium text-white/45 uppercase tracking-wide">Noise Suppression</label>
    <p-select [(ngModel)]="noiseSuppressionMode" [options]="noiseSuppressionOptions"
              optionLabel="label" optionValue="value" styleClass="w-full"/>
    <p class="text-[0.6875rem] text-white/25">
        Standard uses your browser's filter. Enhanced runs RNNoise in the desktop app for
        AI-grade denoising.
    </p>
</div>

@if (noiseSuppressionMode === 'enhanced') {
    <div class="flex flex-col gap-2 bg-white/[0.03] border border-white/[0.10] rounded-xl px-4 py-3">
        <div class="flex items-center justify-between">
            <p class="text-sm text-white/75">Voice Gate Strength</p>
            <span class="text-xs text-white/40 tabular-nums">{{ vadStrength }}%</span>
        </div>
        <p class="text-xs text-white/35 -mt-1">Suppress audio frames below this voice activity
            threshold - raise to cut ambient sound between words</p>
        <p-slider [(ngModel)]="vadStrength" [max]="100" [min]="0" [step]="5" styleClass="w-full mt-1"/>
    </div>
}
```

```ts
readonly noiseSuppressionOptions = [
    {label: 'None', value: 'none' as const},
    {label: 'Standard', value: 'standard' as const},
    {label: 'Enhanced (RNNoise)', value: 'enhanced' as const},
];

get noiseSuppressionMode(): 'none' | 'standard' | 'enhanced' {
    return this.audioSettings.settings().noiseSuppressionMode;
}

set noiseSuppressionMode(v: 'none' | 'standard' | 'enhanced') {
    this.audioSettings.update({noiseSuppressionMode: v});
}
```

Delete the `noiseSuppression` and `enhancedNoiseSuppression` accessors.

- [ ] **Step 4: Verify the build compiles**

Run: `bun run ng build --configuration development`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add src/app/features/settings/settings-modal/pages/voice-video-settings/
git commit -m "feat: cut the Voice and Video page down to Discord's surface"
```

---

### Task 9: Picker service result shape

**Files:**
- Modify: `src/app/services/screen-picker.service.ts`
- Test: `src/app/services/screen-picker.service.spec.ts` (create)

**Interfaces:**
- Consumes: `StreamPreset`, `DEFAULT_STREAM_PRESET` (Task 1).
- Produces: `ScreenPickerChoice { sourceId, sourceWidth, sourceHeight, preset, shareAudio }`, `show(): Promise<ScreenPickerChoice | null>`, `select(choice)`, `cancel()`, `lastPreset(): StreamPreset`.

- [ ] **Step 1: Write the failing test**

```ts
// src/app/services/screen-picker.service.spec.ts
import {TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it} from 'vitest';
import {ScreenPickerService} from './screen-picker.service';

describe('ScreenPickerService', () => {
    beforeEach(() => {
        localStorage.clear();
        TestBed.resetTestingModule();
    });

    it('resolves with the chosen source, preset and audio flag', async () => {
        const picker = TestBed.inject(ScreenPickerService);
        const pending = picker.show();
        picker.select({
            sourceId: 'monitor:0',
            sourceWidth: 2560,
            sourceHeight: 1440,
            preset: {resolution: '1440p', framerate: 60},
            shareAudio: true,
        });
        await expect(pending).resolves.toEqual({
            sourceId: 'monitor:0',
            sourceWidth: 2560,
            sourceHeight: 1440,
            preset: {resolution: '1440p', framerate: 60},
            shareAudio: true,
        });
        expect(picker.visible()).toBe(false);
    });

    it('resolves null when cancelled', async () => {
        const picker = TestBed.inject(ScreenPickerService);
        const pending = picker.show();
        picker.cancel();
        await expect(pending).resolves.toBeNull();
    });

    it('remembers the last preset across instances', () => {
        const picker = TestBed.inject(ScreenPickerService);
        void picker.show();
        picker.select({
            sourceId: 'monitor:0',
            sourceWidth: 1920,
            sourceHeight: 1080,
            preset: {resolution: '720p', framerate: 15},
            shareAudio: false,
        });
        TestBed.resetTestingModule();
        expect(TestBed.inject(ScreenPickerService).lastPreset()).toEqual({resolution: '720p', framerate: 15});
    });

    it('defaults to 1080p30 with no stored preset', () => {
        expect(TestBed.inject(ScreenPickerService).lastPreset()).toEqual({resolution: '1080p', framerate: 30});
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun run ng test`
Expected: FAIL — `select` takes a string, `lastPreset` does not exist.

- [ ] **Step 3: Write the implementation**

```ts
import {inject, Injectable, signal} from '@angular/core';
import {RustMediaService, ScreenSource} from './rust-media.service';
import {DEFAULT_STREAM_PRESET, StreamPreset} from '../models/stream-preset';

export interface ScreenPickerChoice {
    sourceId: string;
    /** Source dimensions, needed to solve capture geometry before capture starts. */
    sourceWidth: number;
    sourceHeight: number;
    preset: StreamPreset;
    /** Whether to capture system audio alongside the video. */
    shareAudio: boolean;
}

const PRESET_KEY = 'alpine_stream_preset';

@Injectable({providedIn: 'root'})
export class ScreenPickerService {
    readonly visible = signal(false);
    readonly sources = signal<ScreenSource[]>([]);
    readonly loading = signal(false);
    private rustMedia = inject(RustMediaService);
    private resolvePickerPromise: ((choice: ScreenPickerChoice | null) => void) | null = null;

    /** The preset used for the previous share, so the picker can preselect it. */
    lastPreset(): StreamPreset {
        try {
            const raw = localStorage.getItem(PRESET_KEY);
            return raw ? {...DEFAULT_STREAM_PRESET, ...JSON.parse(raw)} : {...DEFAULT_STREAM_PRESET};
        } catch {
            return {...DEFAULT_STREAM_PRESET};
        }
    }

    async show(): Promise<ScreenPickerChoice | null> {
        this.visible.set(true);
        this.loading.set(true);
        this.sources.set([]);

        this.rustMedia.getScreenSources().then(list => {
            this.sources.set(list);
            this.loading.set(false);
        }).catch(() => this.loading.set(false));

        return new Promise<ScreenPickerChoice | null>(resolve => {
            this.resolvePickerPromise = resolve;
        });
    }

    select(choice: ScreenPickerChoice): void {
        this.visible.set(false);
        try {
            localStorage.setItem(PRESET_KEY, JSON.stringify(choice.preset));
        } catch { /* storage unavailable */
        }
        this.resolvePickerPromise?.(choice);
        this.resolvePickerPromise = null;
    }

    cancel(): void {
        this.visible.set(false);
        this.resolvePickerPromise?.(null);
        this.resolvePickerPromise = null;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun run ng test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/services/screen-picker.service.ts src/app/services/screen-picker.service.spec.ts
git commit -m "feat: carry preset and audio choice out of the screen picker"
```

---

### Task 10: Two-step picker UI

**Files:**
- Modify: `src/app/features/screen-picker/screen-picker.component.ts`
- Modify: `src/app/features/screen-picker/screen-picker.component.html`

**Interfaces:**
- Consumes: `ScreenPickerChoice`, `lastPreset` (Task 9); `RESOLUTION_LABELS`, `FRAMERATE_OPTIONS`, `solveGeometry` (Tasks 1-2).
- Produces: no exported API change.

- [ ] **Step 1: Add step state and quality selection to the component**

```ts
protected readonly step = signal<'source' | 'quality'>('source');
protected readonly selectedSource = signal<ScreenSource | null>(null);
protected readonly resolution = signal<StreamResolution>('1080p');
protected readonly framerate = signal<StreamFramerate>(30);
protected readonly shareAudio = signal(true);

protected readonly resolutions = Object.entries(RESOLUTION_LABELS)
    .map(([value, label]) => ({value: value as StreamResolution, label}));
protected readonly framerates = FRAMERATE_OPTIONS;

constructor() {
    const preset = this.picker.lastPreset();
    this.resolution.set(preset.resolution);
    this.framerate.set(preset.framerate);
    // ... existing preview effect ...
}

protected select(source: ScreenSource): void {
    this.selectedSource.set(source);
    this.previewStream.set(null);
    this.rustMedia.startScreenCapture(source.id, {width: 640, height: 360}, 1)
        .then(track => this.previewStream.set(new MediaStream([track])))
        .catch(() => {});
}

protected toQuality(): void {
    if (this.selectedSource()) this.step.set('quality');
}

protected back(): void {
    this.step.set('source');
}

protected goLive(): void {
    const source = this.selectedSource();
    if (!source) return;
    this.previewStream.set(null);
    this.picker.select({
        sourceId: source.id,
        sourceWidth: source.width,
        sourceHeight: source.height,
        preset: {resolution: this.resolution(), framerate: this.framerate()},
        shareAudio: this.shareAudio(),
    });
}

protected cancel(): void {
    void this.rustMedia.stopScreenCapture();
    this.previewStream.set(null);
    this.selectedSource.set(null);
    this.step.set('source');
    this.picker.cancel();
}

/** Aspect ratio of a source, for an honest thumbnail. */
protected aspect(source: ScreenSource): string {
    return source.width > 0 && source.height > 0 ? `${source.width}/${source.height}` : '16/9';
}
```

- [ ] **Step 2: Rewrite the template**

Change the tab labels to `Screens` and `Applications`. Replace the fixed `aspect-ratio:16/10` +
`object-cover` thumbnail with the source's own ratio and `object-contain`:

```html
<div class="relative w-full bg-card" [style.aspect-ratio]="aspect(source)">
    @if (thumbSrc(source)) {
        <img [src]="thumbSrc(source)" alt="" class="w-full h-full object-contain"/>
    } @else {
        <div class="flex items-center justify-center w-full h-full text-text-muted">
            <i class="pi pi-desktop text-2xl"></i>
        </div>
    }
</div>
```

Wrap the source grid in `@if (step() === 'source')` and add the quality step:

```html
@if (step() === 'quality') {
    <div class="flex flex-col gap-5 px-5 py-4">
        <div class="flex flex-col gap-2">
            <label class="text-xs font-medium text-text-muted uppercase tracking-wide">Resolution</label>
            <div class="flex gap-2">
                @for (r of resolutions; track r.value) {
                    <button (click)="resolution.set(r.value)"
                            [class.bg-brand]="resolution() === r.value"
                            [class.text-white]="resolution() === r.value"
                            [class.text-text-muted]="resolution() !== r.value"
                            class="flex-1 px-3 py-2 rounded-lg text-xs font-medium border border-border-subtle
                                   transition-colors cursor-pointer">
                        {{ r.label }}
                    </button>
                }
            </div>
        </div>

        <div class="flex flex-col gap-2">
            <label class="text-xs font-medium text-text-muted uppercase tracking-wide">Frame Rate</label>
            <div class="flex gap-2">
                @for (f of framerates; track f) {
                    <button (click)="framerate.set(f)"
                            [class.bg-brand]="framerate() === f"
                            [class.text-white]="framerate() === f"
                            [class.text-text-muted]="framerate() !== f"
                            class="flex-1 px-3 py-2 rounded-lg text-xs font-medium border border-border-subtle
                                   transition-colors cursor-pointer">
                        {{ f }} FPS
                    </button>
                }
            </div>
        </div>

        <label class="flex items-center justify-between bg-white/[0.03] border border-border-subtle
                      rounded-xl px-4 py-3 cursor-pointer">
            <div>
                <p class="text-sm text-text-primary">Share system audio</p>
                <p class="text-xs text-text-muted mt-0.5">Include sound playing on this computer</p>
            </div>
            <p-toggleswitch [ngModel]="shareAudio()" (ngModelChange)="shareAudio.set($event)"/>
        </label>
    </div>
}
```

Replace the footer so it shows Back/Go Live on the quality step and Cancel/Next on the source step.
**Rewrite the corrupted Share button entirely** — the old markup had an unterminated
`[class.bg-white` binding and leaked `cursor-pointer/10]=!selectedId()"` into the static class:

```html
<div class="flex items-center justify-between px-5 py-3.5 border-t border-border-subtle shrink-0">
    <button (click)="step() === 'quality' ? back() : cancel()"
            class="px-4 py-1.5 rounded-lg text-xs font-medium text-text-secondary
                   border border-border-subtle hover:bg-white/[0.05] transition-colors cursor-pointer">
        {{ step() === 'quality' ? 'Back' : 'Cancel' }}
    </button>
    <button (click)="step() === 'quality' ? goLive() : toQuality()"
            [disabled]="!selectedSource()"
            [class.opacity-40]="!selectedSource()"
            [class.cursor-not-allowed]="!selectedSource()"
            class="px-4 py-1.5 rounded-lg text-xs font-semibold bg-brand text-white
                   hover:bg-brand-hover transition-colors cursor-pointer">
        {{ step() === 'quality' ? 'Go Live' : 'Next' }}
    </button>
</div>
```

Import `ToggleSwitch` from `primeng/toggleswitch` and `FormsModule` in the component's `imports`.

- [ ] **Step 3: Verify the build compiles**

Run: `bun run ng build --configuration development`
Expected: success. The old template failed silently; confirm no `selectedId` references remain.

- [ ] **Step 4: Commit**

```bash
git add src/app/features/screen-picker/
git commit -m "feat: give the screen picker a Discord-style quality step"
```

---

### Task 11: Mid-stream settings and viewer UI

**Files:**
- Modify: `src/app/shared/call/call-screen-layout/call-screen-layout.component.ts`
- Modify: `src/app/shared/call/call-screen-layout/call-screen-layout.component.html`
- Modify: `src/app/shared/call/call.types.ts`

**Interfaces:**
- Consumes: `StreamPreset`, `RESOLUTION_LABELS`, `FRAMERATE_OPTIONS` (Task 1).
- Produces: new output `presetChange = output<StreamPreset>()` on `CallScreenLayoutComponent`; `CallScreenShare.preset?: StreamPreset`.

- [ ] **Step 1: Add the pan state and the settings popover**

```ts
presetChange = output<StreamPreset>();

protected readonly settingsOpenFor = signal<string | null>(null);
protected readonly resolutions = Object.entries(RESOLUTION_LABELS)
    .map(([value, label]) => ({value: value as StreamResolution, label}));
protected readonly framerates = FRAMERATE_OPTIONS;

private readonly _pan = signal<Record<string, { x: number; y: number }>>({});
private dragging: { shareId: string; startX: number; startY: number; originX: number; originY: number } | null = null;

protected getPan(shareId: string): { x: number; y: number } {
    return this._pan()[shareId] ?? {x: 0, y: 0};
}

/** Panning only makes sense once the content is larger than its tile. */
protected startPan(shareId: string, event: MouseEvent): void {
    if (this.getZoom(shareId) <= 1) return;
    event.preventDefault();
    const origin = this.getPan(shareId);
    this.dragging = {shareId, startX: event.clientX, startY: event.clientY, originX: origin.x, originY: origin.y};
}

protected movePan(event: MouseEvent): void {
    const drag = this.dragging;
    if (!drag) return;
    this._pan.update(p => ({
        ...p,
        [drag.shareId]: {
            x: drag.originX + (event.clientX - drag.startX),
            y: drag.originY + (event.clientY - drag.startY),
        },
    }));
}

protected endPan(): void {
    this.dragging = null;
}

protected toggleSettings(shareId: string, event: MouseEvent): void {
    event.stopPropagation();
    this.settingsOpenFor.update(id => id === shareId ? null : shareId);
}

protected applyPreset(share: CallScreenShare, patch: Partial<StreamPreset>): void {
    const current = share.preset ?? DEFAULT_STREAM_PRESET;
    this.presetChange.emit({...current, ...patch});
}
```

Reset pan when zoom returns to 1 — add to `zoomOut`:

```ts
if (cur - 0.25 <= 1) this._pan.update(p => ({...p, [shareId]: {x: 0, y: 0}}));
```

- [ ] **Step 2: Fix the tile clipping and wire the transform**

The tile has no `overflow-hidden` on the zoom wrapper, so zooming past 100% overflows. Replace the
wrapper div:

```html
<div class="absolute inset-0 overflow-hidden"
     (mousedown)="startPan(share.shareId, $event)"
     (mousemove)="movePan($event)"
     (mouseup)="endPan()"
     (mouseleave)="endPan()"
     [class.cursor-grab]="getZoom(share.shareId) > 1">
    <div [style.transform]="'translate(' + getPan(share.shareId).x + 'px,' + getPan(share.shareId).y + 'px) scale(' + getZoom(share.shareId) + ')'"
         class="w-full h-full flex items-center justify-center"
         style="transition: transform 0.15s ease; transform-origin: center center">
        <!-- unchanged video / placeholder content -->
    </div>
</div>
```

- [ ] **Step 3: Move the FPS readout behind a cog**

Replace the permanent FPS pill in the bottom-right controls with a cog button shown only on the
local share, and a popover carrying the resolution/framerate rows plus the FPS readout:

```html
@if (share.isLocal) {
    <button (click)="toggleSettings(share.shareId, $event)"
            class="w-8 h-8 flex items-center justify-center rounded-lg bg-black/40 backdrop-blur-sm
                   border border-white/10 hover:bg-black/60 transition-colors cursor-pointer"
            title="Stream settings">
        <i class="pi pi-cog text-sm text-white/70"></i>
    </button>
}

@if (settingsOpenFor() === share.shareId) {
    <div class="absolute bottom-14 right-3 w-64 flex flex-col gap-3 p-3 rounded-xl bg-sidebar
                border border-border-subtle shadow-2xl z-20">
        <div class="flex flex-col gap-1.5">
            <span class="text-[0.625rem] font-medium text-text-muted uppercase tracking-wide">Resolution</span>
            <div class="grid grid-cols-4 gap-1">
                @for (r of resolutions; track r.value) {
                    <button (click)="applyPreset(share, {resolution: r.value})"
                            [class.bg-brand]="(share.preset?.resolution ?? '1080p') === r.value"
                            class="px-1 py-1 rounded text-[0.625rem] font-medium text-white/70 border
                                   border-border-subtle cursor-pointer transition-colors">
                        {{ r.label }}
                    </button>
                }
            </div>
        </div>
        <div class="flex flex-col gap-1.5">
            <span class="text-[0.625rem] font-medium text-text-muted uppercase tracking-wide">Frame Rate</span>
            <div class="grid grid-cols-3 gap-1">
                @for (f of framerates; track f) {
                    <button (click)="applyPreset(share, {framerate: f})"
                            [class.bg-brand]="(share.preset?.framerate ?? 30) === f"
                            class="px-1 py-1 rounded text-[0.625rem] font-medium text-white/70 border
                                   border-border-subtle cursor-pointer transition-colors">
                        {{ f }}
                    </button>
                }
            </div>
        </div>
        @if (share.renderedFps != null) {
            <div class="font-mono text-[0.625rem] text-white/40 pt-1 border-t border-border-subtle">
                capture {{ share.inboundFps ?? 0 }} fps · sent {{ share.renderedFps }} fps
            </div>
        }
    </div>
}
```

- [ ] **Step 4: Add `preset` to the share type**

In `call.types.ts` add `preset?: StreamPreset;` to `CallScreenShare`.

- [ ] **Step 5: Wire the output in both hosts**

`grep -rn "app-call-screen-layout" src/app` finds the consumers (voice channel and call panel). Bind
`(presetChange)` on each to the matching service's `setScreenPreset`.

- [ ] **Step 6: Verify the build compiles**

Run: `bun run ng build --configuration development`
Expected: success.

- [ ] **Step 7: Commit**

```bash
git add src/app/shared/call/
git commit -m "feat: change stream quality mid-share and pan a zoomed stream"
```

---

### Task 12: `webrtc-rs` ↔ Cloudflare interop spike

This is a **spike**: its deliverable is a yes/no answer plus a throwaway binary, not production
code. It gates Tasks 13-14. If it fails, stop and re-plan — the P0-P2 work already shipped stands on
its own.

**Files:**
- Create: `src-tauri/src/bin/spike_publish.rs`
- Modify: `src-tauri/Cargo.toml` (add `webrtc = "0.11"`, `reqwest` with `json` + `rustls-tls`)

**Interfaces:**
- Consumes: the existing backend endpoints listed in `guild-voice.service.ts:74-99`.
- Produces: a documented answer in `docs/superpowers/plans/2026-07-31-discord-parity-streaming.md` under "Spike result".

- [ ] **Step 1: Write the spike binary**

It must: build a `webrtc-rs` `RTCPeerConnection`; add a sendonly H.264 video track fed by a
synthetic colour-bar Annex-B stream; create an offer; POST it to
`/api/v1/guild/guilds/{guildId}/channels/{channelId}/voice/session` then `.../cf/tracks/new` with a
bearer token read from `ALPINE_TOKEN`; apply the answer; and log ICE and connection state
transitions until `connected` or a 30 s timeout.

- [ ] **Step 2: Run it against a real channel**

Run: `cargo run --bin spike_publish -- <guildId> <channelId>`
Expected: `connectionState=connected`, and a second client in the channel sees a `screen-*` track.

- [ ] **Step 3: Record the result**

Append a "Spike result" section to this plan stating whether H.264 publishing to Cloudflare Realtime
via `webrtc-rs` connected, which codec was negotiated, and any SDP incompatibilities found.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/bin/spike_publish.rs src-tauri/Cargo.toml docs/superpowers/plans/2026-07-31-discord-parity-streaming.md
git commit -m "chore: spike webrtc-rs publishing to Cloudflare Realtime"
```

---

### Task 13: Rust encoder abstraction

**Depends on Task 12 succeeding.**

**Files:**
- Create: `src-tauri/src/media/publisher/mod.rs`
- Create: `src-tauri/src/media/publisher/encoder.rs`
- Create: `src-tauri/src/media/publisher/encoder_sw.rs`
- Create: `src-tauri/src/media/publisher/encoder_mf.rs`
- Modify: `src-tauri/src/media/mod.rs`, `src-tauri/Cargo.toml` (add `openh264`)

**Interfaces:**
- Consumes: `RgbaImage` frames from the existing capture thread in `screen.rs`.
- Produces:

```rust
pub struct EncodedChunk { pub data: Vec<u8>, pub is_keyframe: bool, pub timestamp_us: u64 }

pub trait VideoEncoder: Send {
    fn encode(&mut self, frame: &RgbaImage, timestamp_us: u64) -> Option<EncodedChunk>;
    fn request_keyframe(&mut self);
    fn set_bitrate(&mut self, kbps: u32);
}

pub fn new_encoder(width: u32, height: u32, fps: u32, kbps: u32) -> Box<dyn VideoEncoder>;
```

`new_encoder` returns the Media Foundation encoder on Windows when it initialises, and the openh264
software encoder otherwise.

- [ ] **Step 1: Write the failing test**

```rust
// in encoder.rs
#[cfg(test)]
mod tests {
    use super::*;
    use image::RgbaImage;

    #[test]
    fn software_encoder_emits_a_keyframe_first() {
        let mut enc = new_encoder(320, 240, 30, 1000);
        let frame = RgbaImage::from_pixel(320, 240, image::Rgba([16, 32, 64, 255]));
        let chunk = enc.encode(&frame, 0).expect("first frame must encode");
        assert!(chunk.is_keyframe, "the first encoded frame must be a keyframe");
        assert!(chunk.data.len() > 4);
        // Annex-B start code.
        assert_eq!(&chunk.data[0..4], &[0, 0, 0, 1]);
    }

    #[test]
    fn encoder_reports_a_smaller_delta_frame() {
        let mut enc = new_encoder(320, 240, 30, 1000);
        let frame = RgbaImage::from_pixel(320, 240, image::Rgba([16, 32, 64, 255]));
        let key = enc.encode(&frame, 0).unwrap();
        let delta = enc.encode(&frame, 33_333).unwrap();
        assert!(!delta.is_keyframe);
        assert!(delta.data.len() < key.data.len());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test publisher::encoder`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `encoder.rs` and `encoder_sw.rs`**

`encoder_sw.rs` wraps the `openh264` crate: convert RGBA to I420, feed the encoder, collect the
Annex-B layers into an `EncodedChunk`, and report `is_keyframe` from the frame type. `encoder.rs`
holds the trait, the chunk struct and `new_encoder`, which tries `encoder_mf::MfEncoder::new` on
Windows and falls back to the software encoder.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src-tauri && cargo test publisher::encoder`
Expected: PASS.

- [ ] **Step 5: Implement `encoder_mf.rs`**

Media Foundation H.264 via `IMFTransform` with `MFVideoFormat_H264` output and `MFVideoFormat_NV12`
input, hardware activation preferred. Add the `Win32_Media_MediaFoundation` feature to the `windows`
crate dependency. Both encoders must satisfy the same tests.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/media/publisher/ src-tauri/src/media/mod.rs src-tauri/Cargo.toml
git commit -m "feat: add a hardware-preferring H.264 encoder for screen capture"
```

---

### Task 14: Rust publisher and frontend flag

**Depends on Tasks 12 and 13.**

**Files:**
- Create: `src-tauri/src/media/publisher/rtc.rs`
- Create: `src-tauri/src/media/publisher/signalling.rs`
- Modify: `src-tauri/src/media/publisher/mod.rs`, `src-tauri/src/lib.rs`
- Modify: `src/app/services/rust-media.service.ts`, `src/app/services/voice-rtc.service.ts`
- Modify: `src/environments/environment.ts` (add `rustPublisher: boolean`)

**Interfaces:**
- Consumes: `VideoEncoder`, `new_encoder` (Task 13); `ScreenPickerChoice` (Task 9).
- Produces: Tauri commands `start_screen_publish(source_id, width, height, fps, kbps, share_audio, api_base, token, guild_id, channel_id) -> { cf_session_id, track_name }`, `stop_screen_publish()`, `set_publish_preset(width, height, fps, kbps)`; and `RustMediaService.startScreenPublish(...)`, `stopScreenPublish()`.

- [ ] **Step 1: Implement `signalling.rs`**

A thin `reqwest` client mirroring `GuildVoiceService`: `create_session`, `tracks_new`,
`renegotiate`, `close_tracks`. Same paths, `Authorization: Bearer <token>`.

- [ ] **Step 2: Implement `rtc.rs`**

Build a `webrtc-rs` peer connection with a `TrackLocalStaticSample` H.264 track named
`screen-<shareId>`, drive it from the capture thread through `new_encoder`, run the signalling
handshake, and expose the resulting `cf_session_id` and `track_name`.

- [ ] **Step 3: Wire the commands and the frontend flag**

In `voice-rtc.service.ts`, branch in `publishScreen`:

```ts
if (environment.rustPublisher && isTauri()) {
    const published = await this.rustMedia.startScreenPublish({...});
    // Announce over the existing WS path; other clients subscribe by {cfSessionId, trackName}
    // exactly as they already do for browser-published screen tracks.
    return {shareId};
}
// existing canvas path unchanged
```

- [ ] **Step 4: Verify both paths build**

Run: `bun run ng build --configuration development` and `cd src-tauri && cargo build`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/media/publisher/ src-tauri/src/lib.rs src/app/services/ src/environments/
git commit -m "feat: publish screen shares to the SFU from Rust"
```

---

### Task 15: Retire the JPEG frame path

**Depends on Task 14 being verified in a real call.**

**Files:**
- Modify: `src-tauri/src/media/screen.rs`, `src/app/services/rust-media.service.ts`
- Modify: `src/environments/environment.ts`

**Interfaces:**
- Consumes: the verified Rust publisher.
- Produces: `start_screen_preview` / `stop_screen_preview` replacing the full-rate frame channel.

- [ ] **Step 1: Reduce the frame channel to a preview**

Cap the JPEG channel at 5 fps and a 480-pixel-wide output, rename the commands to
`start_screen_preview` / `stop_screen_preview`, and delete the canvas `captureStream` plumbing in
`rust-media.service.ts` — the preview renders straight into an `<img>`.

- [ ] **Step 2: Flip the flag on and delete the fallback branch**

Set `rustPublisher: true` and remove the canvas branch from `publishScreen`.

- [ ] **Step 3: Verify the build compiles and tests pass**

Run: `bun run ng test` and `cd src-tauri && cargo test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/ src/app/services/ src/environments/
git commit -m "refactor: reduce the JPEG frame path to a local preview"
```

---

## Spike result (2026-07-31)

Partially run. Two of the three unknowns are settled; the third needs a live backend.

**Dependencies build.** `webrtc = "0.14"` and `openh264 = "0.9"` both compile in this workspace on
Windows/MSVC. openh264's default `source` feature builds the Cisco library from source via `cc` and
`nasm-rs` with no extra toolchain setup.

**The encoder works.** `media::publisher::encoder_sw::SoftwareEncoder` is implemented and covered by
five passing tests: the first frame is an IDR with an Annex-B start code, timestamps survive,
a static scene's delta frame is smaller than its keyframe, `request_keyframe` forces an IDR, and
ultrawide (1920×540) and portrait (606×1080) geometries encode. openh264 rejects `AdaptiveQuant` and
`BackgroundDetection` for `ScreenContentRealTime`, so both are explicitly disabled.

**Cloudflare interop is NOT verified.** Publishing H.264 from `webrtc-rs` to Cloudflare Realtime
needs a live backend, a bearer token and a real guild/channel, none of which are available here. This
remains the load-bearing risk for Tasks 14-15 and must be proven before either is built.

**Licensing: resolved.** Building OpenH264 from source does *not* carry Cisco's patent grant, which
covers only their precompiled binary. The crate is now on `default-features = false,
features = ["libloading"]` — `source` no longer appears anywhere in the dependency tree — and
`media::publisher::openh264_blob` fetches Cisco's binary at runtime.

Verified end to end on Windows x86_64: `https://ciscobinary.openh264.org/openh264-2.6.0-win64.dll.bz2`
returns 452 KB over HTTPS, decompresses to 978 KB, and hashes to
`2076cb56…b24691` — matching `openh264-sys2`'s baked-in list, so `from_blob_path` accepts it. With
the cache cleared, the encoder tests re-download and pass.

Design constraints this imposes:

- **No mirroring or bundling.** A copy we redistribute is no longer the copy Cisco licensed, which
  rules out the obvious reliability fix. Robustness comes from three retries with backoff, a
  permanent hash-verified cache, and a graceful fallback instead.
- **Unattended.** `spawn_provisioning` runs at startup off the main path; `openh264_status` retries
  on demand so a transient outage at launch resolves itself later.
- **Never a hard failure.** Without the codec, screen sharing keeps using the existing capture path,
  where the webview encodes under Microsoft's own codec licence.
- Cisco's FAQ frames the download as happening "at the time the product is installed"; we do it on
  first run, which is how Firefox ships OpenH264. Whether first-run provisioning satisfies that
  wording is a lawyer question, not an engineering one.

**Not built:** `encoder_mf.rs` (Media Foundation hardware encoder), `rtc.rs`, `signalling.rs`, the
Tauri commands, and the frontend flag. Tasks 13 (partially), 14 and 15 remain open.

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Preset contract | 1 |
| Degradation policy | 3, 5, 6 |
| Fixed geometry | 2, 4 |
| Rust-native publisher | 12, 13, 14 |
| Settings page | 7, 8 |
| Screen picker | 9, 10 |
| Mid-stream settings + viewer UI | 11 |
| `publishCamera` device bug | 5 (Step 4) |
| Corrupted Share button | 10 (Step 2) |
| Retire JPEG path | 15 |

**Type consistency:** `StreamPreset`/`StreamResolution`/`StreamFramerate` are defined once in Task 1
and imported everywhere. `solveGeometry` returns `CaptureGeometry`, which is what
`startScreenCapture` and `setCaptureGeometry` accept. `ScreenPickerChoice` carries
`sourceWidth`/`sourceHeight`, which Task 5 feeds to `solveGeometry`. `applyScreenEncoding` takes
`(sender, preset)` in Tasks 3, 5, 6 and 11.

**Known gap:** Task 12 is a spike whose failure invalidates Tasks 13-15. Tasks 1-11 are independent
of it and deliver every reported complaint on their own.
