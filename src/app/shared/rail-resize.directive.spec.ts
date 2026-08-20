import {ChangeDetectionStrategy, Component} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {beforeAll, beforeEach, describe, expect, it} from 'vitest';

import {RailResizeDirective} from './rail-resize.directive';
import {SCENE_RAIL_STORAGE_KEY} from '../services/scene-rail-state.service';

// This runner's `localStorage` global has no methods. Same Map-backed stand-in
// `scene-rail-state.service.spec.ts` uses.
const localStore = new Map<string, string>();

beforeAll(() => {
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (k: string) => localStore.get(k) ?? null,
            setItem: (k: string, v: string) => void localStore.set(k, String(v)),
            removeItem: (k: string) => void localStore.delete(k),
            clear: () => localStore.clear(),
        },
    });
    // The clamp maths reads this rather than assuming 16px.
    document.documentElement.style.fontSize = '16px';
});

@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [RailResizeDirective],
    template: `<div #box class="box"><div appRailResize [target]="box"></div></div>`,
})
class HostComponent {}

function setup(): {fixture: ComponentFixture<HostComponent>; strip: HTMLElement; box: HTMLElement} {
    TestBed.configureTestingModule({
        imports: [HostComponent],
        providers: [provideTranslateService()],
    });
    const fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();

    const box = fixture.nativeElement.querySelector('.box') as HTMLElement;
    // jsdom lays nothing out, so the box reports whatever `--rail-width` last set, 200px by
    // default, the same as a real browser reflecting a synchronous style write.
    box.getBoundingClientRect = () => {
        const raw = box.style.getPropertyValue('--rail-width');
        return {width: raw ? parseFloat(raw) : 200} as DOMRect;
    };

    const strip = fixture.nativeElement.querySelector('[appRailResize]') as HTMLElement;
    return {fixture, strip, box};
}

function pointer(type: string, clientX: number, pointerId = 1): PointerEvent {
    return new PointerEvent(type, {pointerId, clientX, bubbles: true});
}

function widthOf(box: HTMLElement): string {
    return box.style.getPropertyValue('--rail-width');
}

describe('RailResizeDirective', () => {
    beforeEach(() => {
        localStore.clear();
        document.body.style.removeProperty('user-select');
    });

    it('sets the width on pointerdown then pointermove', () => {
        const {strip, box} = setup();

        strip.dispatchEvent(pointer('pointerdown', 100));
        strip.dispatchEvent(pointer('pointermove', 150));

        expect(widthOf(box)).toBe('250px');
    });

    it('clamps at the minimum', () => {
        const {strip, box} = setup();

        strip.dispatchEvent(pointer('pointerdown', 100));
        strip.dispatchEvent(pointer('pointermove', -900));

        // 11rem at 16px root.
        expect(widthOf(box)).toBe('176px');
    });

    it('clamps at the maximum', () => {
        const {strip, box} = setup();

        strip.dispatchEvent(pointer('pointerdown', 100));
        strip.dispatchEvent(pointer('pointermove', 900));

        // 26rem at 16px root.
        expect(widthOf(box)).toBe('416px');
    });

    it('persists once, on pointerup, not on every pointermove', () => {
        const {strip} = setup();

        strip.dispatchEvent(pointer('pointerdown', 100));
        strip.dispatchEvent(pointer('pointermove', 120));
        strip.dispatchEvent(pointer('pointermove', 140));
        expect(JSON.parse(localStore.get(SCENE_RAIL_STORAGE_KEY) ?? '{}').width).toBeUndefined();

        strip.dispatchEvent(pointer('pointerup', 150));

        expect(JSON.parse(localStore.get(SCENE_RAIL_STORAGE_KEY) ?? '{}').width).toBe(250);
    });

    it('steps by one rem per arrow key press', () => {
        const {strip, box} = setup();

        strip.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));

        expect(widthOf(box)).toBe('216px');
    });

    it('resets to the default on double-click', () => {
        const {strip, box} = setup();
        box.style.setProperty('--rail-width', '300px');

        strip.dispatchEvent(new MouseEvent('dblclick', {bubbles: true}));

        expect(widthOf(box)).toBe('');
        expect(JSON.parse(localStore.get(SCENE_RAIL_STORAGE_KEY) ?? '{}').width).toBeNull();
    });

    it('resets to the default on Home', () => {
        const {strip, box} = setup();
        box.style.setProperty('--rail-width', '300px');

        strip.dispatchEvent(new KeyboardEvent('keydown', {key: 'Home', bubbles: true}));

        expect(widthOf(box)).toBe('');
        expect(JSON.parse(localStore.get(SCENE_RAIL_STORAGE_KEY) ?? '{}').width).toBeNull();
    });

    it('labels the strip from the translation key', () => {
        const {strip} = setup();

        expect(strip.getAttribute('aria-label')).toBe('SCENE.ARCHIVE.RESIZE_RAIL');
    });

    it('blocks text selection across the page while dragging', () => {
        const {strip} = setup();

        strip.dispatchEvent(pointer('pointerdown', 100));

        expect(document.body.style.userSelect).toBe('none');
    });

    it('clears the selection block when a drag is cancelled rather than released', () => {
        const {strip} = setup();
        strip.dispatchEvent(pointer('pointerdown', 100));

        strip.dispatchEvent(pointer('pointercancel', 130));

        expect(document.body.style.userSelect).toBe('');
    });
});
