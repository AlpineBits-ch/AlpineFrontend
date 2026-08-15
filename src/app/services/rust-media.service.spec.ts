/**
 * `RustMediaService` as a delegate over the {@link ScreenPublisher} port.
 *
 * <p>The invoke-payload assertions that used to live here moved to
 * `platform/tauri/screen-publisher.tauri.spec.ts` along with the payload itself. What is left is the
 * delegate's own job, and it is not bookkeeping-free: the port addresses a share by id and this service's
 * public surface has none, so <b>it holds the id</b>. Everything below is about that holding being
 * correct - a stop that names nothing, a stop that names a share that already ended on its own, an audio
 * outcome that has to distinguish "not asked for" from "asked for and impossible".</p>
 *
 * <p>No `vi.mock('@tauri-apps/api/core')`. The two blocks that used to be here are replaced by one
 * provided fake, which is the pattern the design spec asks for: the service no longer knows a native host
 * exists, so there is nothing about it left to mock.</p>
 */
import {TestBed} from '@angular/core/testing';
import {
    PublishSpec,
    ScreenPublisher,
    ScreenPublishOptions,
    ScreenPublishResult,
    ScreenSource,
    SourceThumbnail,
} from '../platform/ports/screen-publisher.port';
import {LocalStreamChunk, ScreenPublisherHost} from '../platform/screen-publisher-host';
import {BACKGROUND_IDLE_MS, PREVIEW_IDLE_MS, RustMediaService} from './rust-media.service';

/**
 * A publisher that records what it was asked to do.
 *
 * <p>`nativeCapture` is false so the canvas pipeline stays out of these tests - it needs a real canvas and
 * a frame feed, and it is not what any of this is about.</p>
 */
class FakePublisher extends ScreenPublisher implements ScreenPublisherHost {
    readonly hasSourcePicker = true;
    readonly nativeCapture = false;

    audioTrackName: string | null = 'screen-audio-abc';
    sourceList: ScreenSource[] = [];
    thumbnailList: SourceThumbnail[] = [];

    readonly started: ScreenPublishOptions[] = [];
    readonly stopped: string[] = [];
    readonly fps: {shareId: string; fps: number}[] = [];
    readonly geometry: {shareId: string; width: number; height: number; kbps: number}[] = [];
    readonly muted: {shareId: string; muted: boolean}[] = [];

    previewSink: ((dataUrl: string) => void) | null = null;
    chunkSink: ((chunk: LocalStreamChunk) => void) | null = null;
    endedSink: (() => void) | null = null;

    /** Every `setLocalStreamEnabled`, in order, so the idle pause's reach into Rust is assertable. */
    readonly localStreamToggles: boolean[] = [];

    async sources(): Promise<ScreenSource[]> {
        return this.sourceList;
    }

    async thumbnails(_ids: string[]): Promise<SourceThumbnail[]> {
        return this.thumbnailList;
    }

    async start(o: ScreenPublishOptions): Promise<ScreenPublishResult> {
        this.started.push(o);
        return {
            mediaSessionId: 'cf-1',
            trackName: `screen-${o.shareId}`,
            audioTrackName: o.shareAudio ? this.audioTrackName : null,
            encoder: 'browser',
        };
    }

    async stop(shareId: string): Promise<void> {
        this.stopped.push(shareId);
    }

    async setFps(shareId: string, fps: number): Promise<void> {
        this.fps.push({shareId, fps});
    }

    async setSpec(shareId: string, spec: PublishSpec): Promise<void> {
        this.geometry.push({shareId, ...spec});
    }

    async setAudioMuted(shareId: string, muted: boolean): Promise<void> {
        this.muted.push({shareId, muted});
    }

    async startNativeScreenCapture(): Promise<void> {
        throw new Error('not used');
    }

    async setNativeCaptureFps(): Promise<void> {
    }

    async setNativeCaptureGeometry(): Promise<void> {
    }

    async stopNativeScreenCapture(): Promise<void> {
    }

    async startNativeLoopbackCapture(): Promise<void> {
        throw new Error('not used');
    }

    async stopNativeLoopbackCapture(): Promise<void> {
    }

    async prefersNativeAudioCapture(): Promise<boolean> {
        return false;
    }

    onPreviewFrame(handler: (dataUrl: string) => void): void {
        this.previewSink = handler;
    }

    onPublishChunk(handler: (chunk: LocalStreamChunk) => void): void {
        this.chunkSink = handler;
    }

    async setLocalStreamEnabled(enabled: boolean): Promise<void> {
        this.localStreamToggles.push(enabled);
    }

    onPublishEnded(handler: () => void): void {
        this.endedSink = handler;
    }
}

/**
 * The port and nothing else - no host half at all.
 *
 * <p>Declared at module scope rather than inside the test that uses it: the bundler resolves a class
 * declaration extending an imported base to `undefined` when it sits inside an async test body, which
 * fails as "Class extends value undefined" and looks like a broken import.</p>
 */
class PortOnlyPublisher extends ScreenPublisher {
    readonly hasSourcePicker = false;

    async sources(): Promise<ScreenSource[]> {
        return [];
    }

    async thumbnails(): Promise<SourceThumbnail[]> {
        return [];
    }

    async start(): Promise<ScreenPublishResult> {
        throw new Error('not used');
    }

    async stop(): Promise<void> {
    }

    async setFps(): Promise<void> {
    }

    async setSpec(): Promise<void> {
    }

    async setAudioMuted(): Promise<void> {
    }
}

function setup(publisher: ScreenPublisher = new FakePublisher()): {
    service: RustMediaService;
    publisher: ScreenPublisher;
} {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({providers: [{provide: ScreenPublisher, useValue: publisher}]});
    return {service: TestBed.inject(RustMediaService), publisher};
}

function options(over: Partial<ScreenPublishOptions> = {}): ScreenPublishOptions {
    return {
        sourceId: 'src-1',
        shareId: 'abc',
        width: 1280,
        height: 720,
        fps: 30,
        kbps: 2500,
        content: 'text',
        iceServers: [],
        apiBase: 'https://api.test',
        token: 'tok',
        deviceId: 'dev-1',
        guildId: 'guild-1',
        channelId: 'chan-1',
        shareAudio: true,
        ...over,
    };
}

describe('RustMediaService: forwarding', () => {
    /**
     * `localStream` is the one field this service decides rather than forwards: it is the answer to
     * "can this webview decode H.264", which no caller is in a position to know. Everything else
     * travels exactly as it was built.
     */
    it('passes the publish options through, deciding only the local-stream request', async () => {
        const fake = new FakePublisher();
        const {service} = setup(fake);

        const o = options();
        const result = await service.startScreenPublish(o);

        expect(fake.started).toEqual([{...o, localStream: expect.any(Boolean)}]);
        expect(result.trackName).toBe('screen-abc');
    });

    /**
     * The suite runs on jsdom, which has no `VideoDecoder` - which is the same answer a Linux
     * WebKitGTK webview gives, and the one that keeps the thumbnail path alive. Asserted rather
     * than assumed, because "the decoder was never asked for" is what makes every other expectation
     * in this file about the thumbnail meaningful.
     */
    it('does not ask for a local stream where nothing can decode one', async () => {
        const fake = new FakePublisher();
        const {service} = setup(fake);

        await service.startScreenPublish(options());

        expect(fake.started[0]?.localStream).toBe(false);
        expect(service.localPublishStream()).toBeNull();
    });

    it('delegates source enumeration and thumbnails', async () => {
        const fake = new FakePublisher();
        fake.sourceList = [{id: 'm0', name: 'Screen 1', isMonitor: true, thumbnail: '', width: 1920, height: 1080}];
        fake.thumbnailList = [{id: 'm0', thumbnail: 'jpeg'}];
        const {service} = setup(fake);

        expect(await service.getScreenSources()).toEqual(fake.sourceList);
        expect(await service.captureSourceThumbnails(['m0'])).toEqual(fake.thumbnailList);
    });

    /**
     * A partial stand-in that carries no host half must not take the service down. Several specs for
     * other services provide exactly that, and the guard is what keeps this an additive port.
     */
    it('works against a publisher with no host surface', async () => {
        const {service} = setup(new PortOnlyPublisher());

        expect(await service.getScreenSources()).toEqual([]);
        expect(await service.shouldUseRustAudio()).toBe(false);
        await expect(service.stopScreenPublish()).resolves.toBeUndefined();
    });
});

describe('RustMediaService: the share id it holds', () => {
    it('names the share it started when stopping, changing fps and muting', async () => {
        const fake = new FakePublisher();
        const {service} = setup(fake);
        await service.startScreenPublish(options({shareId: 'live'}));

        await service.setPublishFps(15);
        await service.setScreenAudioMuted(true);
        await service.stopScreenPublish();

        expect(fake.fps).toEqual([{shareId: 'live', fps: 15}]);
        expect(fake.muted).toEqual([{shareId: 'live', muted: true}]);
        expect(fake.stopped).toEqual(['live']);
    });

    /**
     * The teardown paths call `stopScreenPublish` without knowing whether anything was publishing - the
     * DM call service does it on every hangup. Passing an id it does not have would be inventing one, and
     * the adapters refuse an id that is not live: this must not reach the port at all.
     */
    it('does not touch the port when nothing is publishing', async () => {
        const fake = new FakePublisher();
        const {service} = setup(fake);

        await service.stopScreenPublish();
        await service.setPublishFps(30);
        await service.setScreenAudioMuted(true);

        expect(fake.stopped).toEqual([]);
        expect(fake.fps).toEqual([]);
        expect(fake.muted).toEqual([]);
    });

    it('forgets the share after stopping it, so a second stop is a no-op', async () => {
        const fake = new FakePublisher();
        const {service} = setup(fake);
        await service.startScreenPublish(options({shareId: 'live'}));

        await service.stopScreenPublish();
        await service.stopScreenPublish();

        expect(fake.stopped).toEqual(['live']);
    });

    /** A restart at a new resolution: the second share is the one the controls must address. */
    it('follows the share id across a restart', async () => {
        const fake = new FakePublisher();
        const {service} = setup(fake);

        await service.startScreenPublish(options({shareId: 'first'}));
        await service.stopScreenPublish();
        await service.startScreenPublish(options({shareId: 'second'}));
        await service.setPublishFps(60);

        expect(fake.fps).toEqual([{shareId: 'second', fps: 60}]);
    });

    /**
     * A failed stop must still be forgotten locally. Holding the id after the port refused would leave
     * every later control aimed at a share that is gone.
     */
    it('forgets the share even when the port fails to stop it', async () => {
        const fake = new FakePublisher();
        vi.spyOn(console, 'warn').mockImplementation(() => {
        });
        vi.spyOn(fake, 'stop').mockRejectedValue(new Error('IPC died'));
        const {service} = setup(fake);
        await service.startScreenPublish(options({shareId: 'live'}));

        await expect(service.stopScreenPublish()).resolves.toBeUndefined();
        await service.setPublishFps(15);

        expect(fake.fps).toEqual([]);
    });
});

describe('RustMediaService: what happened to the share audio', () => {
    it('is off when audio was never asked for', async () => {
        const {service} = setup();

        await service.startScreenPublish(options({shareAudio: false}));

        expect(service.screenAudioOutcome()).toBe('off');
    });

    it('is published when a track came back', async () => {
        const {service} = setup();

        await service.startScreenPublish(options({shareAudio: true}));

        expect(service.screenAudioOutcome()).toBe('published');
    });

    /**
     * The case that must not read like the first one. The user ticked "share audio" and this host could
     * not give it - Chromium-only and tab-scoped on web, no usable loopback device on desktop - so the
     * share is video-only and something has to say so.
     */
    it('is unavailable when audio was asked for and none was published', async () => {
        const fake = new FakePublisher();
        fake.audioTrackName = null;
        const {service} = setup(fake);

        await service.startScreenPublish(options({shareAudio: true}));

        expect(service.screenAudioOutcome()).toBe('unavailable');
    });

    it('resets to off when the share stops', async () => {
        const {service} = setup();
        await service.startScreenPublish(options({shareAudio: true}));

        await service.stopScreenPublish();

        expect(service.screenAudioOutcome()).toBe('off');
    });
});

describe('RustMediaService: the sharer own preview', () => {
    it('publishes the preview frames the host pushes', async () => {
        const fake = new FakePublisher();
        const {service} = setup(fake);

        expect(service.publishPreview()).toBeNull();
        fake.previewSink?.('data:image/jpeg;base64,AAAA');

        expect(service.publishPreview()).toBe('data:image/jpeg;base64,AAAA');
    });

    it('clears the preview when the share stops', async () => {
        const fake = new FakePublisher();
        const {service} = setup(fake);
        await service.startScreenPublish(options());
        fake.previewSink?.('data:image/jpeg;base64,AAAA');

        await service.stopScreenPublish();

        expect(service.publishPreview()).toBeNull();
    });

    /**
     * The host ending the capture on its own - a web user pressing the browser's "Stop sharing".
     *
     * <p>The publisher has already torn its own publish down by this point, so the id must be dropped
     * without a second stop: naming it again would be a stale command, which the adapters refuse.</p>
     */
    it('drops the share when the host ends the capture, without stopping it twice', async () => {
        const fake = new FakePublisher();
        const {service} = setup(fake);
        await service.startScreenPublish(options({shareId: 'live'}));
        const ended = vi.fn();
        service.publishEnded$.subscribe(ended);

        fake.endedSink?.();

        expect(ended).toHaveBeenCalledTimes(1);
        expect(service.publishPreview()).toBeNull();
        expect(service.screenAudioOutcome()).toBe('off');
        await service.stopScreenPublish();
        expect(fake.stopped).toEqual([]);
    });
});

/**
 * Task 10: the idle pause. `fakeAsync` does not work in this repo (no ProxyZone), so every test
 * here drives the clock with `vi.useFakeTimers()` / `vi.advanceTimersByTime` instead.
 *
 * <p>The point of most of these is that a frame delivered <i>after</i> pausing genuinely stops
 * landing in {@link RustMediaService.publishPreview} - not just that {@link
 * RustMediaService.previewPaused} flipped a boolean. A test that only checked the flag would still
 * pass with the frame-gating in the `onPreviewFrame` handler deleted.</p>
 */
describe('RustMediaService: idle preview pause', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        delete (document as unknown as Record<string, unknown>)['hidden'];
    });

    /** jsdom's `document.hidden` is a real getter on the prototype; shadow it with an own property,
     *  exactly as the hotkeys suite does for `visibilityState`, and delete it in afterEach to fall
     *  back to the real one. */
    function setHidden(hidden: boolean): void {
        Object.defineProperty(document, 'hidden', {configurable: true, get: () => hidden});
    }

    it('keeps applying frames indefinitely while claimed and visible', async () => {
        setHidden(false);
        const fake = new FakePublisher();
        const {service} = setup(fake);
        await service.startScreenPublish(options());
        service.claimPreviewRender({});
        fake.previewSink?.('data:image/jpeg;base64,AAAA');

        vi.advanceTimersByTime(PREVIEW_IDLE_MS * 3);
        fake.previewSink?.('data:image/jpeg;base64,BBBB');

        expect(service.previewPaused()).toBe(false);
        expect(service.publishPreview()).toBe('data:image/jpeg;base64,BBBB');
    });

    it('stops applying frames once the idle window elapses with nothing claiming the preview', async () => {
        setHidden(false);
        const fake = new FakePublisher();
        const {service} = setup(fake);
        await service.startScreenPublish(options());
        fake.previewSink?.('data:image/jpeg;base64,AAAA');

        vi.advanceTimersByTime(PREVIEW_IDLE_MS);
        expect(service.previewPaused()).toBe(true);

        // The real assertion: a frame that arrives after pausing must not land.
        fake.previewSink?.('data:image/jpeg;base64,BBBB');
        expect(service.publishPreview()).toBe('data:image/jpeg;base64,AAAA');
    });

    it('stops applying frames the moment the window is hidden, even while claimed', async () => {
        setHidden(false);
        const fake = new FakePublisher();
        const {service} = setup(fake);
        await service.startScreenPublish(options());
        service.claimPreviewRender({});
        fake.previewSink?.('data:image/jpeg;base64,AAAA');

        setHidden(true);
        document.dispatchEvent(new Event('visibilitychange'));

        // No advance: hidden means the window left the screen, which gets no grace at all - see
        // `previewPauseDelay` and the background block below, where merely losing focus does.
        expect(service.previewPaused()).toBe(true);
        fake.previewSink?.('data:image/jpeg;base64,BBBB');
        expect(service.publishPreview()).toBe('data:image/jpeg;base64,AAAA');
    });

    it('does not pause a visible, claimed preview just because it once went idle and came back', async () => {
        // Claiming again before the window elapses must cancel the countdown, not merely delay it.
        setHidden(false);
        const fake = new FakePublisher();
        const {service} = setup(fake);
        await service.startScreenPublish(options());
        fake.previewSink?.('data:image/jpeg;base64,AAAA');

        vi.advanceTimersByTime(PREVIEW_IDLE_MS - 1000);
        const token = {};
        service.claimPreviewRender(token);
        vi.advanceTimersByTime(PREVIEW_IDLE_MS);

        expect(service.previewPaused()).toBe(false);
    });

    it('resumes applying frames once resumePreview is called', async () => {
        setHidden(false);
        const fake = new FakePublisher();
        const {service} = setup(fake);
        await service.startScreenPublish(options());
        fake.previewSink?.('data:image/jpeg;base64,AAAA');
        vi.advanceTimersByTime(PREVIEW_IDLE_MS);
        expect(service.previewPaused()).toBe(true);

        service.resumePreview();

        expect(service.previewPaused()).toBe(false);
        fake.previewSink?.('data:image/jpeg;base64,CCCC');
        expect(service.publishPreview()).toBe('data:image/jpeg;base64,CCCC');
    });

    it('never pauses while nothing is being shared at all, no matter how long it runs hidden', async () => {
        setHidden(true);
        const fake = new FakePublisher();
        const {service} = setup(fake);

        vi.advanceTimersByTime(PREVIEW_IDLE_MS * 3);

        expect(service.previewPaused()).toBe(false);
    });

    it('leaves the running stream untouched across a full pause/resume cycle', async () => {
        setHidden(false);
        const fake = new FakePublisher();
        const {service} = setup(fake);
        await service.startScreenPublish(options({shareId: 'live'}));
        fake.previewSink?.('data:image/jpeg;base64,AAAA');

        vi.advanceTimersByTime(PREVIEW_IDLE_MS);
        expect(service.previewPaused()).toBe(true);
        service.resumePreview();

        // No stop, no fps change, no mute - pausing and resuming the local render never reached the
        // publisher, and the share id the service holds is exactly what it started with.
        expect(fake.stopped).toEqual([]);
        expect(fake.fps).toEqual([]);
        expect(fake.muted).toEqual([]);
        await service.setPublishFps(24);
        expect(fake.fps).toEqual([{shareId: 'live', fps: 24}]);
    });

    it('clears the pause when the share stops, so the next share starts unpaused', async () => {
        setHidden(false);
        const fake = new FakePublisher();
        const {service} = setup(fake);
        await service.startScreenPublish(options());
        fake.previewSink?.('data:image/jpeg;base64,AAAA');
        vi.advanceTimersByTime(PREVIEW_IDLE_MS);
        expect(service.previewPaused()).toBe(true);

        await service.stopScreenPublish();

        expect(service.previewPaused()).toBe(false);
    });

    it('starts a fresh idle countdown once the only claim is released, even while visible', async () => {
        setHidden(false);
        const fake = new FakePublisher();
        const {service} = setup(fake);
        await service.startScreenPublish(options());
        const token = {};
        service.claimPreviewRender(token);
        fake.previewSink?.('data:image/jpeg;base64,AAAA');

        // Claimed and visible - the countdown startScreenPublish began on its own must have been
        // cancelled by the claim.
        vi.advanceTimersByTime(PREVIEW_IDLE_MS);
        expect(service.previewPaused()).toBe(false);

        service.releasePreviewRender(token);
        vi.advanceTimersByTime(PREVIEW_IDLE_MS);

        expect(service.previewPaused()).toBe(true);
    });

    /**
     * The actual bug: a share whose first preview frame arrives after the idle window would end up
     * permanently frame-locked. The idle timer used to arm at `startScreenPublish` regardless of
     * whether a preview existed yet, fire at {@link PREVIEW_IDLE_MS} with no frame ever received, and
     * then `onPreviewFrame`'s own pause check would drop every frame after that forever - there was
     * no card to click "resume" on, because the paused card is itself gated on a preview existing.
     */
    it('does not pre-arm the idle timer before a first preview frame exists, so a late first frame still lands', async () => {
        setHidden(false);
        const fake = new FakePublisher();
        const {service} = setup(fake);
        await service.startScreenPublish(options());

        // No frame yet - a share that has never had a preview has nothing to pause.
        vi.advanceTimersByTime(PREVIEW_IDLE_MS * 3);
        expect(service.previewPaused()).toBe(false);

        fake.previewSink?.('data:image/jpeg;base64,LATE');

        expect(service.previewPaused()).toBe(false);
        expect(service.publishPreview()).toBe('data:image/jpeg;base64,LATE');
    });

    it('starts the idle countdown from the first frame, not from startScreenPublish, when the frame arrives late', async () => {
        setHidden(false);
        const fake = new FakePublisher();
        const {service} = setup(fake);
        await service.startScreenPublish(options());

        vi.advanceTimersByTime(PREVIEW_IDLE_MS - 1000);
        fake.previewSink?.('data:image/jpeg;base64,LATE');

        // The countdown starts now, not PREVIEW_IDLE_MS - 1000 ago.
        vi.advanceTimersByTime(PREVIEW_IDLE_MS - 1);
        expect(service.previewPaused()).toBe(false);

        vi.advanceTimersByTime(1);
        expect(service.previewPaused()).toBe(true);
    });

    /**
     * `startScreenPublish` re-arms the idle clock but, before this fix, never cleared a pause left
     * over from whatever previously held `activeShareId` - so a second publish starting while an
     * earlier paused one was still active began already paused, frozen over the old share's frame.
     */
    it('does not begin already paused when a new publish starts over a stale pause from a previous share', async () => {
        setHidden(false);
        const fake = new FakePublisher();
        const {service} = setup(fake);
        await service.startScreenPublish(options({shareId: 'first'}));
        fake.previewSink?.('data:image/jpeg;base64,AAAA');
        vi.advanceTimersByTime(PREVIEW_IDLE_MS);
        expect(service.previewPaused()).toBe(true);

        // A second publish starting without an intervening stop - startScreenPublish itself must
        // clear the stale pause, not only stopScreenPublish.
        await service.startScreenPublish(options({shareId: 'second'}));

        expect(service.previewPaused()).toBe(false);
        fake.previewSink?.('data:image/jpeg;base64,BBBB');
        expect(service.publishPreview()).toBe('data:image/jpeg;base64,BBBB');
    });
});

/**
 * The background pause: the app is not the window you are looking at, so nothing here can see the
 * preview and decoding frames into it is work nobody benefits from.
 *
 * <p><b>What changed, and why the old tests here inverted.</b> `blur` used to pause on the spot and
 * `focus` used to un-pause on the spot, on the reasoning that a window behind another window is one
 * nobody is looking at. Correct about the window, wrong about the user: alt-tabbing to the thing you
 * are sharing is the most ordinary half-minute in a screen share, and it froze the card every time.
 * So the two are now separate questions - <i>when</i> it pauses (after {@link BACKGROUND_IDLE_MS},
 * not at once) and <i>how</i> it comes back (the resume button, and nothing else).</p>
 *
 * <p>Minimising is deliberately still immediate. `document.hidden` means the window left the screen,
 * which is a decision rather than a glance - see the minimise tests below, and
 * `previewPauseDelay`.</p>
 *
 * <p><b>What these cannot reach.</b> Every assertion here is on the JPEG thumbnail, because the
 * saving that actually matters - `setLocalStreamEnabled`, which stops the share-bitrate encoded feed
 * crossing IPC - hangs off `localRenderer`, and jsdom has no `VideoDecoder` to build one with. So
 * these prove the timing rule and the latch; they cannot prove the effect that acts on it. Mutate
 * that effect and this file stays green.</p>
 */
describe('RustMediaService: background preview pause', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        Object.defineProperty(document, 'hidden', {configurable: true, get: () => false});
    });

    afterEach(() => {
        vi.useRealTimers();
        delete (document as unknown as Record<string, unknown>)['hidden'];
        window.dispatchEvent(new Event('focus'));
    });

    /** A share that is publishing, claimed, visible, and has a frame to freeze over. */
    async function sharing(): Promise<{fake: FakePublisher; service: RustMediaService}> {
        const fake = new FakePublisher();
        const {service} = setup(fake);
        await service.startScreenPublish(options());
        service.claimPreviewRender({});
        fake.previewSink?.('data:image/jpeg;base64,AAAA');
        return {fake, service};
    }

    it('keeps applying frames for the whole background grace after the window loses focus', async () => {
        const {fake, service} = await sharing();

        window.dispatchEvent(new Event('blur'));
        vi.advanceTimersByTime(BACKGROUND_IDLE_MS - 1);

        // The regression this whole change is about: a glance away from the app is not a pause.
        expect(service.previewPaused()).toBe(false);
        fake.previewSink?.('data:image/jpeg;base64,BBBB');
        expect(service.publishPreview()).toBe('data:image/jpeg;base64,BBBB');
    });

    it('pauses once the background grace elapses', async () => {
        const {fake, service} = await sharing();

        window.dispatchEvent(new Event('blur'));
        vi.advanceTimersByTime(BACKGROUND_IDLE_MS);

        expect(service.previewPaused()).toBe(true);
        // The assertion that outlives the flag: a frame arriving afterwards must not land.
        fake.previewSink?.('data:image/jpeg;base64,BBBB');
        expect(service.publishPreview()).toBe('data:image/jpeg;base64,AAAA');
    });

    it('stays paused when the window comes back, until the resume button is pressed', async () => {
        const {fake, service} = await sharing();
        window.dispatchEvent(new Event('blur'));
        vi.advanceTimersByTime(BACKGROUND_IDLE_MS);

        window.dispatchEvent(new Event('focus'));

        // Coming back to the app is a request for the app, not for a decode of your own screen.
        expect(service.previewPaused()).toBe(true);
        fake.previewSink?.('data:image/jpeg;base64,BBBB');
        expect(service.publishPreview()).toBe('data:image/jpeg;base64,AAAA');

        service.resumePreview();

        expect(service.previewPaused()).toBe(false);
        fake.previewSink?.('data:image/jpeg;base64,CCCC');
        expect(service.publishPreview()).toBe('data:image/jpeg;base64,CCCC');
    });

    it('cancels the countdown outright when the window comes back inside the grace', async () => {
        const {fake, service} = await sharing();

        window.dispatchEvent(new Event('blur'));
        vi.advanceTimersByTime(BACKGROUND_IDLE_MS / 2);
        window.dispatchEvent(new Event('focus'));
        // Cancelled, not merely restarted - sitting in the focused app must never pause on a clock
        // that started before the user came back.
        vi.advanceTimersByTime(BACKGROUND_IDLE_MS * 3);

        expect(service.previewPaused()).toBe(false);
        fake.previewSink?.('data:image/jpeg;base64,BBBB');
        expect(service.publishPreview()).toBe('data:image/jpeg;base64,BBBB');
    });

    it('restarts the countdown from scratch on a second blur rather than resuming the first', async () => {
        const {service} = await sharing();

        window.dispatchEvent(new Event('blur'));
        vi.advanceTimersByTime(BACKGROUND_IDLE_MS - 1000);
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new Event('blur'));
        vi.advanceTimersByTime(BACKGROUND_IDLE_MS - 1);

        expect(service.previewPaused()).toBe(false);
        vi.advanceTimersByTime(1);
        expect(service.previewPaused()).toBe(true);
    });

    /**
     * The reason the deadline is stored as a wall-clock instant rather than left to the timer. A
     * backgrounded renderer is under Chromium's intensive throttling, so the very `setTimeout` this
     * feature arms is the one least likely to fire on time - see the same trap in
     * `voice-liveness-backgrounded.spec.ts`. `onPreviewFrame` runs off the IPC feed instead, so the
     * next frame after the deadline is what lands the pause.
     */
    it('pauses on the next frame when the timer is throttled past its deadline', async () => {
        const {fake, service} = await sharing();
        window.dispatchEvent(new Event('blur'));

        // The clock moves; the timer does not run. That is what throttling looks like from here.
        vi.setSystemTime(Date.now() + BACKGROUND_IDLE_MS + 60_000);
        expect(service.previewPaused()).toBe(false);

        fake.previewSink?.('data:image/jpeg;base64,BBBB');

        expect(service.previewPaused()).toBe(true);
        // That frame was the one that noticed, so it is allowed to land - the freeze starts after.
        fake.previewSink?.('data:image/jpeg;base64,CCCC');
        expect(service.publishPreview()).toBe('data:image/jpeg;base64,BBBB');
    });

    it('pauses at once when the window is minimised, without waiting out the grace', async () => {
        const {fake, service} = await sharing();

        Object.defineProperty(document, 'hidden', {configurable: true, get: () => true});
        document.dispatchEvent(new Event('visibilitychange'));

        expect(service.previewPaused()).toBe(true);
        fake.previewSink?.('data:image/jpeg;base64,BBBB');
        expect(service.publishPreview()).toBe('data:image/jpeg;base64,AAAA');
    });

    it('stays paused after being un-minimised, exactly as it does after being un-backgrounded', async () => {
        const {service} = await sharing();
        Object.defineProperty(document, 'hidden', {configurable: true, get: () => true});
        document.dispatchEvent(new Event('visibilitychange'));

        Object.defineProperty(document, 'hidden', {configurable: true, get: () => false});
        document.dispatchEvent(new Event('visibilitychange'));

        expect(service.previewPaused()).toBe(true);
        service.resumePreview();
        expect(service.previewPaused()).toBe(false);
    });

    it('never claims to be paused while nothing is being shared', async () => {
        // Consumers gate the paused card on a preview existing, so a stray true renders nothing -
        // but it would still be a lie, and the flag is read by more than the card.
        const fake = new FakePublisher();
        const {service} = setup(fake);

        window.dispatchEvent(new Event('blur'));
        vi.advanceTimersByTime(BACKGROUND_IDLE_MS * 3);

        expect(service.previewPaused()).toBe(false);
    });

    it('does not report a pause for a share whose first frame has not arrived yet', async () => {
        // Same rule the idle pause follows: a share with no preview behind it has nothing to freeze,
        // and pausing one would drop the very first frame it is waiting for.
        const fake = new FakePublisher();
        const {service} = setup(fake);
        await service.startScreenPublish(options());

        window.dispatchEvent(new Event('blur'));
        vi.advanceTimersByTime(BACKGROUND_IDLE_MS * 3);
        expect(service.previewPaused()).toBe(false);

        // And the first frame still lands while backgrounded, so there is something to freeze over.
        fake.previewSink?.('data:image/jpeg;base64,FIRST');
        expect(service.publishPreview()).toBe('data:image/jpeg;base64,FIRST');
    });

    /**
     * Two reasons at once must not add up to the longer wait. Nobody rendering the preview is the
     * stronger signal of the two and keeps its own thirty seconds, whether or not the window
     * happens to be in the background as well.
     */
    it('keeps the shorter unclaimed window when a blurred preview also loses its last claim', async () => {
        const fake = new FakePublisher();
        const {service} = setup(fake);
        await service.startScreenPublish(options());
        const token = {};
        service.claimPreviewRender(token);
        fake.previewSink?.('data:image/jpeg;base64,AAAA');

        window.dispatchEvent(new Event('blur'));
        service.releasePreviewRender(token);
        vi.advanceTimersByTime(PREVIEW_IDLE_MS);

        expect(service.previewPaused()).toBe(true);
    });
});
