import {ChangeDetectionStrategy, Component, inject} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {beforeEach, describe, expect, it} from 'vitest';
import {ProfileCanvasEditorComponent} from './profile-canvas-editor.component';
import {CanvasEditorService} from '../../../services/canvas-editor.service';
import {ProfileCanvasApiService} from '../../../services/profile-canvas-api.service';
import {WIDGET_REGISTRY} from '../../../components/profile-canvas/widget-registry';
import {CanvasWidgetDto, ProfileCanvasDto} from '../../../dtos/response/profile-canvas.dto';
import {OnlineStatus, ProfileDto, ProfileFont} from '../../../dtos/response/profile.dto';
import {CANVAS_COLUMNS, emptyCanvas, MAX_WIDGETS} from '../../../models/profile-canvas';

const OWNER: ProfileDto = {
    id: 'p1',
    userId: 'u1',
    userName: 'Nova',
    bio: undefined,
    avatarUrl: undefined,
    bannerUrl: undefined,
    accentColor: null,
    font: ProfileFont.Default,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    onlineStatus: OnlineStatus.Online,
};

function widget(id: string, over: Partial<CanvasWidgetDto> = {}): CanvasWidgetDto {
    return {
        id,
        type: 'quote',
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        visibility: 'everyone',
        card: false,
        config: {},
        ...over,
    };
}

function canvasOf(widgets: CanvasWidgetDto[]): ProfileCanvasDto {
    return {...emptyCanvas('p1'), widgets};
}

@Component({
    imports: [ProfileCanvasEditorComponent],
    template: ` <app-profile-canvas-editor [canvas]="editor.draft() ?? undefined" [owner]="owner" /> `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
class HostComponent {
    readonly editor = inject(CanvasEditorService);
    readonly owner = OWNER;
}

function setup(canvas: ProfileCanvasDto = emptyCanvas('p1')) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
        providers: [
            provideTranslateService(),
            {provide: ProfileCanvasApiService, useValue: {imageUrl: (id: string) => `img/${id}`}},
        ],
    });
    const fixture: ComponentFixture<HostComponent> = TestBed.createComponent(HostComponent);
    const editor = TestBed.inject(CanvasEditorService);
    editor.begin(canvas);
    fixture.detectChanges();
    return {fixture, editor};
}

function el(fixture: ComponentFixture<unknown>): HTMLElement {
    return fixture.nativeElement as HTMLElement;
}

function testId(fixture: ComponentFixture<unknown>, id: string): HTMLElement | null {
    return el(fixture).querySelector(`[data-testid="${id}"]`);
}

function lattice(fixture: ComponentFixture<unknown>): HTMLElement {
    return testId(fixture, 'canvas-lattice')!;
}

function canvasHost(fixture: ComponentFixture<unknown>): HTMLElement {
    return testId(fixture, 'canvas-host')!;
}

/** CANVAS_COLUMNS(4) cells at 100px each, so cell (cx, cy) sits at (cx * 100 + 50, cy * 100 + 50). */
function stubGrid(fixture: ComponentFixture<unknown>): void {
    const rect = {left: 0, top: 0, right: 400, bottom: 400, width: 400, height: 400, x: 0, y: 0};
    canvasHost(fixture).getBoundingClientRect = () => ({...rect, toJSON: () => rect}) as DOMRect;
}

function cellPoint(cx: number, cy: number): {clientX: number; clientY: number} {
    return {clientX: cx * 100 + 50, clientY: cy * 100 + 50};
}

function fakeDataTransfer(): DataTransfer {
    const store = new Map<string, string>();
    return {
        setData: (type: string, value: string) => store.set(type, value),
        getData: (type: string) => store.get(type) ?? '',
        effectAllowed: 'none',
        dropEffect: 'none',
    } as unknown as DataTransfer;
}

function fireDrag(
    target: HTMLElement,
    type: string,
    point: {clientX: number; clientY: number} = {clientX: 0, clientY: 0},
): DragEvent {
    const event = new Event(type, {bubbles: true, cancelable: true}) as DragEvent;
    Object.defineProperty(event, 'clientX', {value: point.clientX, configurable: true});
    Object.defineProperty(event, 'clientY', {value: point.clientY, configurable: true});
    Object.defineProperty(event, 'dataTransfer', {value: fakeDataTransfer(), configurable: true});
    target.dispatchEvent(event);
    return event;
}

function startDrag(fixture: ComponentFixture<unknown>, widgetId: string): void {
    fireDrag(tile(fixture, widgetId), 'dragstart');
    fixture.detectChanges();
}

function dragTo(fixture: ComponentFixture<unknown>, cx: number, cy: number): void {
    fireDrag(canvasHost(fixture), 'dragover', cellPoint(cx, cy));
    fixture.detectChanges();
}

function dropAt(fixture: ComponentFixture<unknown>, cx: number, cy: number): void {
    fireDrag(canvasHost(fixture), 'drop', cellPoint(cx, cy));
    fixture.detectChanges();
}

function tile(fixture: ComponentFixture<unknown>, widgetId: string): HTMLElement {
    return el(fixture).querySelector(`[data-widget-id="${widgetId}"]`)!;
}

function menuRows(fixture: ComponentFixture<unknown>): HTMLElement[] {
    return Array.from(el(fixture).querySelectorAll<HTMLElement>('[role="menuitem"]'));
}

function openWidgetMenu(fixture: ComponentFixture<unknown>): void {
    testId(fixture, 'add-widget')!.click();
    fixture.detectChanges();
}

const PREVIEW_ORDER = ['me', 'friend', 'mutual', 'stranger'] as const;

function previewButtons(fixture: ComponentFixture<unknown>): HTMLElement[] {
    return Array.from(el(fixture).querySelectorAll<HTMLElement>('[data-testid="preview-viewer"]'));
}

function clickPreview(fixture: ComponentFixture<unknown>, viewer: (typeof PREVIEW_ORDER)[number]): void {
    previewButtons(fixture)[PREVIEW_ORDER.indexOf(viewer)].click();
    fixture.detectChanges();
}

describe('ProfileCanvasEditorComponent', () => {
    beforeEach(() => {
        // jsdom implements no `matchMedia` or popover API; the context menu feature-detects both.
        if (!window.matchMedia) {
            window.matchMedia = ((query: string) => ({
                matches: false,
                media: query,
                onchange: null,
                addEventListener: () => undefined,
                removeEventListener: () => undefined,
                addListener: () => undefined,
                removeListener: () => undefined,
                dispatchEvent: () => false,
            })) as unknown as typeof window.matchMedia;
        }
    });

    it('renders every widget on the canvas', () => {
        const {fixture} = setup(canvasOf([widget('w1'), widget('w2', {x: 1})]));

        expect(tile(fixture, 'w1')).not.toBeNull();
        expect(tile(fixture, 'w2')).not.toBeNull();
    });

    // Catches the lattice being wired to a column count other than the shared CANVAS_COLUMNS
    // constant, hardcoded or otherwise: this canvas is empty, so canvasRowCount() is 1 and the
    // cell total is columns alone.
    it('draws exactly CANVAS_COLUMNS lattice cells for an empty canvas', () => {
        const {fixture} = setup(emptyCanvas('p1'));

        const cells = lattice(fixture).querySelectorAll(':scope > div');
        expect(cells.length).toBe(CANVAS_COLUMNS);
    });

    // Catches an off-by-one in canvasRowCount: a 2-high widget at y=0 must read as 2 rows, not 1
    // (under-count) and not 3 (over-count).
    it('sizes the lattice to max(widget.y + widget.h) across a multi-row canvas', () => {
        const {fixture} = setup(
            canvasOf([widget('tall', {w: 2, h: 2}), widget('short', {x: 2, w: 1, h: 1})]),
        );

        const cells = lattice(fixture).querySelectorAll(':scope > div');
        expect(cells.length).toBe(CANVAS_COLUMNS * 2);
    });

    it('the Add widget affordance is always present', () => {
        const {fixture} = setup(emptyCanvas('p1'));
        expect(testId(fixture, 'add-widget')).not.toBeNull();
    });

    it('lists every widget registry type in the picker', () => {
        const {fixture} = setup(emptyCanvas('p1'));
        openWidgetMenu(fixture);

        const labels = menuRows(fixture).map(row => row.querySelector('.cm-label')?.textContent?.trim());
        expect(labels).toEqual(WIDGET_REGISTRY.map(definition => definition.labelKey));
    });

    it('disables a type that is already at its max', () => {
        // marquee's max is 1.
        const {fixture} = setup(canvasOf([widget('m1', {type: 'marquee'})]));
        openWidgetMenu(fixture);

        const marquee = menuRows(fixture).find(
            row => row.querySelector('.cm-label')?.textContent?.trim() === 'PROFILE.CANVAS.WIDGET.MARQUEE',
        )!;
        expect(marquee.getAttribute('aria-disabled')).toBe('true');
    });

    it('inserting a widget adds it to the draft and selects it', async () => {
        const {fixture, editor} = setup(emptyCanvas('p1'));
        openWidgetMenu(fixture);

        const quote = menuRows(fixture).find(
            row => row.querySelector('.cm-label')?.textContent?.trim() === 'PROFILE.CANVAS.WIDGET.QUOTE',
        )!;
        quote.click();
        fixture.detectChanges();
        await fixture.whenStable();
        fixture.detectChanges();

        expect(editor.draft()!.widgets).toHaveLength(1);
        const inserted = editor.draft()!.widgets[0];

        expect(tile(fixture, inserted.id).getAttribute('aria-pressed')).toBe('true');
        expect(testId(fixture, 'widget-editor-popover')).not.toBeNull();
    });

    it('the picker is dismissible by Escape', () => {
        const {fixture} = setup(emptyCanvas('p1'));
        openWidgetMenu(fixture);
        expect(menuRows(fixture).length).toBeGreaterThan(0);

        el(fixture)
            .querySelector('.cm-root')!
            .dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
        fixture.detectChanges();

        expect(menuRows(fixture).length).toBe(0);
    });

    it('clicking a tile selects it and anchors the editor popover', () => {
        const {fixture} = setup(canvasOf([widget('w1')]));

        tile(fixture, 'w1').click();
        fixture.detectChanges();

        expect(testId(fixture, 'widget-editor-popover')).not.toBeNull();
        expect(tile(fixture, 'w1').getAttribute('aria-pressed')).toBe('true');
    });

    it('deleting the selected widget removes it and clears the selection', () => {
        const {fixture, editor} = setup(canvasOf([widget('w1')]));
        tile(fixture, 'w1').click();
        fixture.detectChanges();
        expect(testId(fixture, 'widget-editor-popover')).not.toBeNull();

        testId(fixture, 'delete-widget')!.click();
        fixture.detectChanges();

        expect(editor.draft()!.widgets).toHaveLength(0);
        expect(testId(fixture, 'widget-editor-popover')).toBeNull();
    });

    // F1: only the per-type max (marquee at 1) was covered before. Fill the draft to the global
    // cap with types nowhere near their own max, so only MAX_WIDGETS itself can be refusing them.
    it('disables every entry in the picker once the draft is at MAX_WIDGETS', () => {
        const widgets = Array.from({length: MAX_WIDGETS}, (_, i) => widget(`w${i}`, {y: i}));
        const {fixture} = setup(canvasOf(widgets));
        openWidgetMenu(fixture);

        const rows = menuRows(fixture);
        expect(rows).toHaveLength(WIDGET_REGISTRY.length);
        expect(rows.every(row => row.getAttribute('aria-disabled') === 'true')).toBe(true);
    });

    it('the preview control always renders', () => {
        const {fixture} = setup(emptyCanvas('p1'));
        expect(previewButtons(fixture)).toHaveLength(4);
    });

    it('a widget the previewed viewer cannot see dims rather than disappears', () => {
        const {fixture} = setup(canvasOf([widget('w1', {visibility: 'friends'})]));

        clickPreview(fixture, 'stranger');

        expect(tile(fixture, 'w1')).not.toBeNull();
        expect(tile(fixture, 'w1').style.opacity).toBe('0.4');
    });

    it('a dimmed widget is not aria-hidden, and its state is announced instead', () => {
        const {fixture} = setup(canvasOf([widget('w1', {visibility: 'friends'})]));

        clickPreview(fixture, 'stranger');

        expect(tile(fixture, 'w1').getAttribute('aria-hidden')).not.toBe('true');
        expect(testId(fixture, 'preview-hidden-widget')).not.toBeNull();
    });

    it('a widget visible to the previewed viewer is not dimmed', () => {
        const {fixture} = setup(canvasOf([widget('w1', {visibility: 'everyone'})]));

        clickPreview(fixture, 'stranger');

        expect(tile(fixture, 'w1').style.opacity).toBe('');
    });

    it('the count line reports how many are hidden for that viewer', () => {
        const {fixture} = setup(
            canvasOf([
                widget('w1', {visibility: 'friends'}),
                widget('w2', {y: 1, visibility: 'mutuals'}),
                widget('w3', {y: 2, visibility: 'everyone'}),
            ]),
        );

        clickPreview(fixture, 'stranger');

        expect(testId(fixture, 'preview-hidden-count')?.getAttribute('data-hidden-count')).toBe('2');
    });

    it('no count line renders under Me', () => {
        const {fixture} = setup(canvasOf([widget('w1', {visibility: 'friends'})]));

        expect(testId(fixture, 'preview-hidden-count')).toBeNull();
    });

    // The important one: a preview that filters by mutating the draft is a data-loss bug.
    it('switching viewer never mutates the draft', () => {
        const {fixture, editor} = setup(canvasOf([widget('w1', {visibility: 'friends'})]));
        const before = JSON.stringify(editor.draft());

        clickPreview(fixture, 'friend');
        clickPreview(fixture, 'mutual');
        clickPreview(fixture, 'stranger');
        clickPreview(fixture, 'me');

        expect(JSON.stringify(editor.draft())).toBe(before);
    });

    describe('grid drag', () => {
        it('dropping past the content inserts spacers and lands the tile at the target', () => {
            const {fixture, editor} = setup(
                canvasOf([
                    widget('big', {type: 'marquee', w: 4, h: 1}),
                    widget('small', {type: 'local-time', w: 1, h: 1, y: 1}),
                ]),
            );
            stubGrid(fixture);

            startDrag(fixture, 'small');
            dragTo(fixture, 2, 2);
            dropAt(fixture, 2, 2);

            const widgets = editor.draft()!.widgets;
            expect(widgets.find(w => w.id === 'small')).toMatchObject({x: 2, y: 2});
            expect(widgets.some(w => w.type === 'spacer')).toBe(true);
        });

        it('dropping on an occupied cell reorders with no spacers', () => {
            const {fixture, editor} = setup(canvasOf([widget('a'), widget('b', {x: 1})]));
            stubGrid(fixture);

            startDrag(fixture, 'b');
            dragTo(fixture, 0, 0);
            dropAt(fixture, 0, 0);

            const widgets = editor.draft()!.widgets;
            expect(widgets.map(w => w.id)).toEqual(['b', 'a']);
            expect(widgets.some(w => w.type === 'spacer')).toBe(false);
        });

        it('dropping a tile on itself is a no-op that does not dirty the draft', () => {
            const {fixture, editor} = setup(canvasOf([widget('a'), widget('b', {y: 1})]));
            stubGrid(fixture);
            const before = editor.draft();

            startDrag(fixture, 'a');
            dragTo(fixture, 0, 0);
            dropAt(fixture, 0, 0);

            expect(editor.draft()).toBe(before);
            expect(editor.dirty()).toBe(false);
        });

        it('a spacer cannot be dragged', () => {
            const {fixture} = setup(canvasOf([widget('sp', {type: 'spacer'})]));
            expect(tile(fixture, 'sp').draggable).toBe(false);
        });

        it('a widget tile is draggable', () => {
            const {fixture} = setup(canvasOf([widget('a')]));
            expect(tile(fixture, 'a').draggable).toBe(true);
        });

        it('dragover prevents default so the drop can fire', () => {
            const {fixture} = setup(canvasOf([widget('a')]));
            stubGrid(fixture);

            startDrag(fixture, 'a');
            const over = fireDrag(canvasHost(fixture), 'dragover', cellPoint(1, 0));

            expect(over.defaultPrevented).toBe(true);
        });

        it('the lattice shows while a tile is dragging and hides once the drag ends', () => {
            const {fixture} = setup(canvasOf([widget('a')]));
            stubGrid(fixture);
            expect(lattice(fixture).classList.contains('opacity-100')).toBe(false);

            startDrag(fixture, 'a');
            expect(lattice(fixture).classList.contains('opacity-100')).toBe(true);

            fireDrag(canvasHost(fixture), 'dragend');
            fixture.detectChanges();
            expect(lattice(fixture).classList.contains('opacity-100')).toBe(false);
        });

        it('shows a drop indicator over the target cell while dragging', () => {
            const {fixture} = setup(canvasOf([widget('a'), widget('b', {x: 1})]));
            stubGrid(fixture);

            startDrag(fixture, 'a');
            expect(testId(fixture, 'drop-indicator')).toBeNull();

            dragTo(fixture, 3, 0);
            const indicator = testId(fixture, 'drop-indicator')!;
            expect(indicator).not.toBeNull();
            expect(indicator.style.left).toBe('300px');
            expect(indicator.style.top).toBe('0px');
        });
    });

    describe('keyboard parity', () => {
        it('arrow keys move the selection between tiles in reading order', () => {
            const {fixture} = setup(canvasOf([widget('a'), widget('b', {x: 1})]));

            canvasHost(fixture).dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));
            fixture.detectChanges();
            expect(tile(fixture, 'a').getAttribute('aria-pressed')).toBe('true');

            canvasHost(fixture).dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));
            fixture.detectChanges();
            expect(tile(fixture, 'b').getAttribute('aria-pressed')).toBe('true');
            expect(tile(fixture, 'a').getAttribute('aria-pressed')).toBe('false');

            canvasHost(fixture).dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowLeft', bubbles: true}));
            fixture.detectChanges();
            expect(tile(fixture, 'a').getAttribute('aria-pressed')).toBe('true');
        });

        it('a modified arrow key moves the selected tile instead of the selection', () => {
            const {fixture, editor} = setup(canvasOf([widget('a'), widget('b', {x: 1})]));
            tile(fixture, 'a').click();
            fixture.detectChanges();

            canvasHost(fixture).dispatchEvent(
                new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true, shiftKey: true}),
            );
            fixture.detectChanges();

            expect(editor.draft()!.widgets.map(w => w.id)).toEqual(['b', 'a']);
        });

        it('a spacer is skipped when arrow keys move the selection', () => {
            const {fixture} = setup(
                canvasOf([widget('a'), widget('sp', {type: 'spacer', x: 1}), widget('b', {x: 2})]),
            );

            canvasHost(fixture).dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));
            fixture.detectChanges();
            canvasHost(fixture).dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));
            fixture.detectChanges();

            expect(tile(fixture, 'b').getAttribute('aria-pressed')).toBe('true');
        });
    });
});
