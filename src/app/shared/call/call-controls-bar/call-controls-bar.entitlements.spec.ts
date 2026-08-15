/**
 * The controls bar against a plan.
 *
 * <p>Guide section 8 asks for two of its three things here: a share button disabled before it can
 * be refused, and a quality picker clamped to the granted rung. The shape matters as much as the
 * behaviour - a control that would only be turned down is <b>disabled with a reason on it</b>, never
 * removed, because it works elsewhere and an absent button reads as a client that cannot do this at
 * all.</p>
 */
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {describe, expect, it} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {CallControlsBarComponent} from './call-controls-bar.component';
import {SlotCount} from '../../../core/voice-limits';
import {StreamPreset, VideoCeiling} from '../../../models/stream-preset';

interface Options {
    isCameraOn?: boolean;
    isScreenSharing?: boolean;
    preset?: StreamPreset | null;
    cameraBlockedKey?: string | null;
    shareBlockedKey?: string | null;
    publisherSlots?: SlotCount | null;
    videoCeiling?: VideoCeiling | null;
}

function render(options: Options = {}): ComponentFixture<CallControlsBarComponent> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        imports: [CallControlsBarComponent, TranslateModule.forRoot()],
    });

    const fixture = TestBed.createComponent(CallControlsBarComponent);
    const ref = fixture.componentRef;
    ref.setInput('isMuted', false);
    ref.setInput('isDeafened', false);
    ref.setInput('isCameraOn', options.isCameraOn ?? false);
    ref.setInput('isScreenSharing', options.isScreenSharing ?? false);
    ref.setInput('preset', options.preset ?? null);
    ref.setInput('disconnectLabel', 'Disconnect');
    ref.setInput('cameraBlockedKey', options.cameraBlockedKey ?? null);
    ref.setInput('shareBlockedKey', options.shareBlockedKey ?? null);
    ref.setInput('publisherSlots', options.publisherSlots ?? null);
    ref.setInput('videoCeiling', options.videoCeiling ?? null);
    fixture.detectChanges();
    return fixture;
}

function button(fixture: ComponentFixture<CallControlsBarComponent>, testid: string): HTMLButtonElement {
    return fixture.nativeElement.querySelector(`[data-testid="${testid}"]`) as HTMLButtonElement;
}

/** The segment buttons of one picker group, by the aria-label on the group. */
function segments(fixture: ComponentFixture<CallControlsBarComponent>, label: string): HTMLButtonElement[] {
    const group = fixture.nativeElement.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
    return group ? Array.from(group.querySelectorAll('button')) : [];
}

describe('the camera and share buttons', () => {
    it('are live when the room has said nothing about a limit', () => {
        const fixture = render();

        expect(button(fixture, 'camera-toggle').disabled).toBe(false);
        expect(button(fixture, 'share-toggle').disabled).toBe(false);
        expect(fixture.nativeElement.querySelector('[data-testid="publisher-slots"]')).toBeNull();
    });

    it('are disabled, present and explained when the room will not carry video', () => {
        const fixture = render({
            cameraBlockedKey: 'VOICE.DEGRADED.AUDIO_ONLY',
            shareBlockedKey: 'VOICE.DEGRADED.AUDIO_ONLY',
        });

        const camera = button(fixture, 'camera-toggle');
        // Still on screen. Removing it would read as a client that cannot do this at all.
        expect(camera).not.toBeNull();
        expect(camera.disabled).toBe(true);
        expect(camera.getAttribute('title')).toBe('VOICE.DEGRADED.AUDIO_ONLY');
        expect(button(fixture, 'share-toggle').disabled).toBe(true);
    });

    /** Stopping is never blocked, so the caller passes null while the publication is live. */
    it('stays live for a camera that is already on', () => {
        const fixture = render({isCameraOn: true, cameraBlockedKey: null});

        expect(button(fixture, 'camera-toggle').disabled).toBe(false);
    });

    it('draws the publisher queue as a count rather than leaving it a mystery', () => {
        const fixture = render({
            publisherSlots: {used: 2, max: 2},
            shareBlockedKey: 'VOICE.DEGRADED.PUBLISHERS_FULL',
        });

        const badge = fixture.nativeElement.querySelector('[data-testid="publisher-slots"]');
        expect(badge.textContent.trim()).toBe('2/2');
        expect(button(fixture, 'share-toggle').getAttribute('title'))
            .toBe('VOICE.DEGRADED.PUBLISHERS_FULL');
    });
});

describe('the quality picker', () => {
    const SHARING = {isScreenSharing: true, preset: {resolution: '720p', framerate: 30, content: 'text'} as StreamPreset};

    it('offers everything when no rung has been resolved', () => {
        const fixture = render(SHARING);

        expect(segments(fixture, 'CALL.RESOLUTION').every(b => !b.disabled)).toBe(true);
        expect(segments(fixture, 'CALL.FRAMERATE').every(b => !b.disabled)).toBe(true);
    });

    it('stops where the granted rung stops, without removing the options', () => {
        const fixture = render({...SHARING, videoCeiling: {maxHeight: 720, maxFramerate: 30}});

        const resolutions = segments(fixture, 'CALL.RESOLUTION');
        // 720p, 1080p, 1440p, 2160p, Source - all five still drawn, which is what keeps the picker
        // from silently having fewer buttons on one server than on another.
        expect(resolutions).toHaveLength(5);
        // Source is the one that stays live above the rung: its height is unknowable here, so the
        // server clamps it and says so rather than this client guessing what it is worth.
        expect(resolutions.map(b => b.disabled)).toEqual([false, true, true, true, false]);

        const framerates = segments(fixture, 'CALL.FRAMERATE');
        // 15 and 30 legal, 60 not: a lower framerate is always allowed on any rung above `none`.
        expect(framerates.map(b => b.disabled)).toEqual([false, false, true]);
    });

    /**
     * The top rung, which is what a Pro guild resolves to once the instance's own ceiling carries
     * it. Until then every room caps lower and the 4K button is drawn disabled like any other option
     * above the rung - the build is never what decides this.
     */
    it('lights up 4K only where the rung reaches it', () => {
        const top = render({...SHARING, videoCeiling: {maxHeight: 2160, maxFramerate: 60}});
        expect(segments(top, 'CALL.RESOLUTION').map(b => b.disabled))
            .toEqual([false, false, false, false, false]);

        // The rung the shipped operator ceiling produces today, whatever the plan granted.
        const capped = render({...SHARING, videoCeiling: {maxHeight: 1080, maxFramerate: 60}});
        expect(segments(capped, 'CALL.RESOLUTION').map(b => b.disabled))
            .toEqual([false, false, true, true, false]);
    });

    /**
     * Negative: pressing a disabled option emits nothing. The `disabled` attribute already stops a
     * mouse, and this is what stops anything else - a synthetic click, a test, a stray dispatch.
     */
    it('emits nothing for an option above the rung', () => {
        const fixture = render({...SHARING, videoCeiling: {maxHeight: 720, maxFramerate: 30}});
        const emitted: StreamPreset[] = [];
        fixture.componentInstance.presetChange.subscribe(p => emitted.push(p));

        segments(fixture, 'CALL.RESOLUTION')[1].click();
        segments(fixture, 'CALL.FRAMERATE')[2].click();
        expect(emitted).toEqual([]);

        segments(fixture, 'CALL.RESOLUTION')[0].click();
        expect(emitted).toEqual([{resolution: '720p', framerate: 30, content: 'text'}]);
    });
});

/**
 * The content mode, which is the one row of the three that a plan never restricts.
 *
 * <p>It costs the room nothing - it changes what the encoder gives up under pressure, not how much
 * it spends - so a rung that caps resolution and framerate must still leave both modes live. A
 * ceiling leaking into this row would be a paywall on legibility.</p>
 */
describe('the content mode row', () => {
    const SHARING_TEXT = {
        isScreenSharing: true,
        preset: {resolution: '1080p', framerate: 30, content: 'text'} as StreamPreset,
    };

    it('offers both modes and marks the current one', () => {
        const fixture = render(SHARING_TEXT);
        const modes = segments(fixture, 'CALL.OPTIMIZE_FOR');

        expect(modes.length).toBe(2);
        expect(modes.map(b => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
    });

    it('stays live under a rung that caps both other rows', () => {
        const fixture = render({...SHARING_TEXT, videoCeiling: {maxHeight: 720, maxFramerate: 30}});

        expect(segments(fixture, 'CALL.OPTIMIZE_FOR').every(b => !b.disabled)).toBe(true);
    });

    it('emits the new mode leaving resolution and framerate alone', () => {
        const fixture = render(SHARING_TEXT);
        const emitted: StreamPreset[] = [];
        fixture.componentInstance.presetChange.subscribe(p => emitted.push(p));

        segments(fixture, 'CALL.OPTIMIZE_FOR')[0].click();

        expect(emitted).toEqual([{resolution: '1080p', framerate: 30, content: 'games'}]);
    });

    it('is absent when nothing is being shared', () => {
        expect(segments(render(), 'CALL.OPTIMIZE_FOR')).toEqual([]);
    });
});
