import {ComponentFixture, TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';
import {EmbedPlayerComponent, isFramablePlayerUrl} from './embed-player.component';

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

describe('EmbedPlayerComponent frame', () => {
    async function play(): Promise<HTMLIFrameElement | null> {
        TestBed.resetTestingModule();
        await TestBed.configureTestingModule({imports: [EmbedPlayerComponent]}).compileComponents();

        const fixture: ComponentFixture<EmbedPlayerComponent> =
            TestBed.createComponent(EmbedPlayerComponent);
        fixture.componentRef.setInput('video', {
            url: 'https://www.youtube.com/embed/dQw4w9WgXcQ',
            width: 1280,
            height: 720,
        });
        fixture.detectChanges();

        (fixture.componentInstance as unknown as { playing: { set(v: boolean): void } })
            .playing.set(true);
        fixture.detectChanges();

        return fixture.nativeElement.querySelector('iframe');
    }

    it('nothing is framed until the frame is asked for', async () => {
        TestBed.resetTestingModule();
        await TestBed.configureTestingModule({imports: [EmbedPlayerComponent]}).compileComponents();
        const fixture = TestBed.createComponent(EmbedPlayerComponent);
        fixture.componentRef.setInput('video', {url: 'https://www.youtube.com/embed/x'});
        fixture.detectChanges();

        // Mounting the frame on scroll would tell YouTube this person read this message before
        // they expressed any interest in the video at all.
        expect(fixture.nativeElement.querySelector('iframe')).toBeNull();
    });

    /**
     * The frontend guide's snippet says `referrerpolicy="no-referrer"`, and following it is what
     * made every YouTube embed fail on click: /embed/ will not configure a player for a request
     * with no Referer header, and answers "Error 153, video player configuration error" instead.
     * Verified by loading one video three ways from a single page - only the no-referrer frame
     * errored. This test exists because the guide still says otherwise.
     */
    it('does not strip the referrer, which YouTube rejects with error 153', async () => {
        const iframe = await play();

        expect(iframe).not.toBeNull();
        expect(iframe!.getAttribute('referrerpolicy')).not.toBe('no-referrer');
        // Origin only - the path would say which channel the viewer is reading.
        expect(iframe!.getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
    });

    it('keeps the frame sandboxed and lazy', async () => {
        const iframe = await play();

        // Whitelisting decides whose document loads; the sandbox decides what it may then do.
        const sandbox = iframe!.getAttribute('sandbox') ?? '';
        expect(sandbox).toContain('allow-scripts');
        expect(sandbox).not.toContain('allow-top-navigation');
        expect(sandbox).not.toContain('allow-modals');
        expect(iframe!.getAttribute('loading')).toBe('lazy');
    });
});
