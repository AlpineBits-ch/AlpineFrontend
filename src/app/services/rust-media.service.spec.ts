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
    ScreenPublisher,
    ScreenPublishOptions,
    ScreenPublishResult,
    ScreenSource,
    SourceThumbnail,
} from '../platform/ports/screen-publisher.port';
import {ScreenPublisherHost} from '../platform/screen-publisher-host';
import {RustMediaService} from './rust-media.service';

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
    readonly muted: {shareId: string; muted: boolean}[] = [];

    previewSink: ((dataUrl: string) => void) | null = null;
    endedSink: (() => void) | null = null;

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
    it('passes the publish options through untouched', async () => {
        const fake = new FakePublisher();
        const {service} = setup(fake);

        const o = options();
        const result = await service.startScreenPublish(o);

        expect(fake.started).toEqual([o]);
        expect(result.trackName).toBe('screen-abc');
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
