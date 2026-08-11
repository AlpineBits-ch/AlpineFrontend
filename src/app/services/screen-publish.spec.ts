import {environment} from '../../environments/environment';
import {StreamPreset} from '../models/stream-preset';
import {iceServers, publishOptions, useRustPublisher} from './screen-publish';

describe('iceServers', () => {
    it('keeps STUN servers', () => {
        const urls = iceServers().flatMap(s => s.urls);
        expect(urls.some(u => u.startsWith('stun:'))).toBe(true);
    });

    it('drops TURN and TURNS entries', () => {
        // Cloudflare's SFU is ICE-lite on public IPs, so no relay is needed to reach it. Passing
        // relay entries would make webrtc-rs attempt allocations that cannot authenticate, and the
        // publish waits for gathering to complete before offering.
        const urls = iceServers().flatMap(s => s.urls);
        expect(urls.some(u => u.startsWith('turn:'))).toBe(false);
        expect(urls.some(u => u.startsWith('turns:'))).toBe(false);
    });

    it('returns no server entry left empty by the filter', () => {
        // webrtc-rs rejects a server with no URLs, so an entry that was TURN-only must be removed
        // rather than passed through hollow.
        expect(iceServers().every(s => s.urls.length > 0)).toBe(true);
    });
});

/**
 * Which pipeline owns a share.
 *
 * <p>`environment.rustPublisher` is the documented one-line rollback from the Rust publisher to the canvas
 * pipeline, and it has to keep meaning exactly that. A browser has no Rust side to roll back to, so it
 * must not be gated on that flag - if it were, flipping the desktop rollback would silently disable screen
 * sharing on the web client.</p>
 */
describe('useRustPublisher', () => {
    const original = environment.rustPublisher;

    afterEach(() => {
        environment.rustPublisher = original;
        delete (window as {__TAURI_INTERNALS__?: unknown}).__TAURI_INTERNALS__;
    });

    it('is true in a browser even with the Rust rollback engaged', () => {
        environment.rustPublisher = false;

        expect(useRustPublisher()).toBe(true);
    });

    it('follows the rollback flag on the desktop host', () => {
        (window as {__TAURI_INTERNALS__?: unknown}).__TAURI_INTERNALS__ = {};

        environment.rustPublisher = true;
        expect(useRustPublisher()).toBe(true);

        environment.rustPublisher = false;
        expect(useRustPublisher()).toBe(false);
    });
});

/**
 * The single place a preset becomes pixels, for either host.
 *
 * <p>Both adapters consume this and neither re-derives it - see the parity tests in
 * `platform/web/screen-publisher.web.spec.ts`, which assert the numbers at the point they reach the
 * browser and the native encoder rather than here.</p>
 */
describe('publishOptions', () => {
    const preset: StreamPreset = {resolution: '1080p', framerate: 30};
    const choice = {
        sourceId: 'monitor:0',
        sourceWidth: 3840,
        sourceHeight: 2160,
        preset,
        shareAudio: true,
    };

    function built(over: Partial<typeof choice> = {}) {
        return publishOptions({...choice, ...over}, 'share-1', 'https://api.test', 'tok', 'dev-1',
            {guildId: 'g', channelId: 'c'});
    }

    it('solves the geometry from the source and the preset', () => {
        expect(built()).toMatchObject({width: 1920, height: 1080, fps: 30, kbps: 4500});
    });

    /** Never upscale: a 720p source shared at 1080p stays 720p. */
    it('does not blow a small source up to the preset box', () => {
        expect(built({sourceWidth: 1280, sourceHeight: 720})).toMatchObject({width: 1280, height: 720});
    });

    /**
     * The preset travels alongside the numbers it produced. The web sender's encoding parameters are
     * applied by `applyScreenEncoding`, which takes a preset - passing the real one is what stops the
     * browser path inventing its own idea of a bitrate floor and a framerate cap.
     */
    it('carries the preset it solved from', () => {
        expect(built().preset).toEqual(preset);
    });

    it('carries the audio request and the target through unchanged', () => {
        expect(built()).toMatchObject({shareAudio: true, guildId: 'g', channelId: 'c'});
        expect(built({shareAudio: false}).shareAudio).toBe(false);
    });
});
