import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {WidgetEditorPopoverComponent} from './widget-editor-popover.component';
import {CanvasEditorService} from '../../../services/canvas-editor.service';
import {ProfileCanvasApiService} from '../../../services/profile-canvas-api.service';
import {emptyCanvas} from '../../../models/profile-canvas';
import {CanvasWidgetDto} from '../../../dtos/response/profile-canvas.dto';
import {POPOUT_MARGIN} from '../../../components/profile-popout/place-popout';

function anchorAt(rect: Partial<DOMRect>): HTMLElement {
    const el = document.createElement('div');
    document.body.appendChild(el);
    el.getBoundingClientRect = () =>
        ({left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, ...rect}) as DOMRect;
    return el;
}

function setViewport(width: number, height: number): void {
    Object.defineProperty(window, 'innerWidth', {value: width, configurable: true, writable: true});
    Object.defineProperty(window, 'innerHeight', {value: height, configurable: true, writable: true});
}

describe('WidgetEditorPopoverComponent', () => {
    let fixture: ComponentFixture<WidgetEditorPopoverComponent>;
    let widget: CanvasWidgetDto;
    let anchor: HTMLElement;

    function card(): HTMLElement {
        return fixture.nativeElement.querySelector('[role="dialog"]');
    }

    function render(rect: Partial<DOMRect> = {left: 100, right: 300, top: 100}) {
        TestBed.configureTestingModule({
            imports: [WidgetEditorPopoverComponent],
            providers: [provideTranslateService(), {provide: ProfileCanvasApiService, useValue: {}}],
        });

        const editor = TestBed.inject(CanvasEditorService);
        editor.begin(emptyCanvas('p1'));
        editor.insert('quote');
        widget = editor.draft()!.widgets[0];
        anchor = anchorAt(rect);

        fixture = TestBed.createComponent(WidgetEditorPopoverComponent);
        fixture.componentRef.setInput('widget', widget);
        fixture.componentRef.setInput('anchor', anchor);
        document.body.appendChild(fixture.nativeElement);
        fixture.detectChanges();
        return {editor};
    }

    beforeEach(() => setViewport(1024, 768));

    afterEach(() => {
        anchor?.remove();
        fixture?.nativeElement.remove();
        TestBed.resetTestingModule();
    });

    it('hosts the widget properties panel for the given widget', () => {
        render();
        expect(fixture.nativeElement.querySelector('app-widget-properties')).not.toBeNull();
    });

    it('shows a delete affordance', () => {
        render();
        expect(fixture.nativeElement.querySelector('[data-testid="delete-widget"]')).not.toBeNull();
    });

    it('deleting removes the widget from the draft and emits deleted', () => {
        const {editor} = render();
        const deleted = vi.fn();
        fixture.componentInstance.deleted.subscribe(deleted);

        (fixture.nativeElement as HTMLElement)
            .querySelector<HTMLButtonElement>('[data-testid="delete-widget"]')!
            .click();

        expect(editor.draft()!.widgets).toHaveLength(0);
        expect(deleted).toHaveBeenCalledOnce();
    });

    it('emits escaped, not dismissed, on Escape', () => {
        render();
        const escaped = vi.fn();
        const dismissed = vi.fn();
        fixture.componentInstance.escaped.subscribe(escaped);
        fixture.componentInstance.dismissed.subscribe(dismissed);

        card().dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));

        expect(escaped).toHaveBeenCalledOnce();
        expect(dismissed).not.toHaveBeenCalled();
    });

    it('emits dismissed for a pointerdown outside the card and the anchor', () => {
        render();
        const dismissed = vi.fn();
        fixture.componentInstance.dismissed.subscribe(dismissed);

        document.body.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));

        expect(dismissed).toHaveBeenCalledOnce();
    });

    it('does not dismiss for a pointerdown on the card itself', () => {
        render();
        const dismissed = vi.fn();
        fixture.componentInstance.dismissed.subscribe(dismissed);

        card().dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));

        expect(dismissed).not.toHaveBeenCalled();
    });

    it('does not dismiss for a pointerdown on the anchor: the tile owns that toggle', () => {
        render();
        const dismissed = vi.fn();
        fixture.componentInstance.dismissed.subscribe(dismissed);

        anchor.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));

        expect(dismissed).not.toHaveBeenCalled();
    });

    it('positions to the left of a rightmost-column tile rather than overflowing', () => {
        render({left: 950, right: 1010, top: 200});

        expect(parseFloat(card().style.left) + 320).toBeLessThanOrEqual(1024);
        expect(parseFloat(card().style.left)).toBeLessThan(950);
    });

    it('flips to the right of a leftmost-column tile when there is no room on the left', () => {
        render({left: 20, right: 80, top: 200});
        fixture.detectChanges();

        expect(parseFloat(card().style.left)).toBeGreaterThanOrEqual(80);
    });

    it('caps its own height to the viewport instead of pushing the page', () => {
        setViewport(1024, 400);
        render({left: 100, right: 300, top: 350});

        expect(parseFloat(card().style.maxHeight)).toBeLessThanOrEqual(400 - 2 * POPOUT_MARGIN);
    });

    it('moves focus into itself once placed, so a keyboard user lands inside it', () => {
        render();
        expect(document.activeElement).toBe(card());
    });

    it('moves focus back into itself when the selected widget changes while it stays open', async () => {
        const {editor} = render();
        editor.insert('marquee');
        const other = editor.draft()!.widgets.find(w => w.id !== widget.id)!;

        (document.activeElement as HTMLElement | null)?.blur();
        expect(document.activeElement).not.toBe(card());

        fixture.componentRef.setInput('widget', other);
        fixture.detectChanges();
        await fixture.whenStable();

        expect(document.activeElement).toBe(card());
    });

    it('does not steal focus back on an edit to a field of the same widget', async () => {
        render();
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.focus();
        expect(document.activeElement).toBe(input);

        fixture.componentRef.setInput('widget', {...widget});
        fixture.detectChanges();
        await fixture.whenStable();

        expect(document.activeElement).toBe(input);
        input.remove();
    });
});
