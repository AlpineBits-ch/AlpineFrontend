import {iceServers} from './screen-publish';

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
