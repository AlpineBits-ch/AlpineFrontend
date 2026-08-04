import {describe, expect, it} from 'vitest';
import {isFramablePlayerUrl} from './embed-player.component';

/**
 * The server builds `video.url` from an extracted id against its own whitelist, so a scraped page
 * cannot choose what we frame. This is the second lock: the client decides what the client loads,
 * and a compromised unfurler must not be able to talk us into framing an arbitrary document.
 */
describe('isFramablePlayerUrl', () => {
    it('accepts the whitelisted players', () => {
        expect(isFramablePlayerUrl('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe(true);
        expect(isFramablePlayerUrl('https://www.youtube-nocookie.com/embed/x')).toBe(true);
        expect(isFramablePlayerUrl('https://player.vimeo.com/video/12345')).toBe(true);
        expect(isFramablePlayerUrl('https://player.twitch.tv/?video=1')).toBe(true);
        expect(isFramablePlayerUrl('https://open.spotify.com/embed/track/x')).toBe(true);
    });

    it('rejects any other host', () => {
        expect(isFramablePlayerUrl('https://evil.example/embed')).toBe(false);
        // A lookalike host that merely contains a whitelisted one as a substring.
        expect(isFramablePlayerUrl('https://www.youtube.com.evil.example/embed')).toBe(false);
        expect(isFramablePlayerUrl('https://evil.example/?x=www.youtube.com')).toBe(false);
    });

    it('rejects anything that is not https', () => {
        expect(isFramablePlayerUrl('http://www.youtube.com/embed/x')).toBe(false);
        expect(isFramablePlayerUrl('javascript:alert(1)')).toBe(false);
        expect(isFramablePlayerUrl('data:text/html,<script></script>')).toBe(false);
    });

    it('rejects rather than throwing on nothing at all', () => {
        expect(isFramablePlayerUrl(undefined)).toBe(false);
        expect(isFramablePlayerUrl('')).toBe(false);
        expect(isFramablePlayerUrl('not a url')).toBe(false);
    });
});
