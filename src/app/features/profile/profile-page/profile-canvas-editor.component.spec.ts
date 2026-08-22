import {ChangeDetectionStrategy, Component, inject, signal} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {beforeEach, describe, expect, it} from 'vitest';
import {ProfileCanvasEditorComponent} from './profile-canvas-editor.component';
import {CanvasEditorService} from '../../../services/canvas-editor.service';
import {ProfileCanvasApiService} from '../../../services/profile-canvas-api.service';
import {WIDGET_REGISTRY} from '../../../components/profile-canvas/widget-registry';
import {CanvasWidgetDto, ProfileCanvasDto} from '../../../dtos/response/profile-canvas.dto';
import {OnlineStatus, ProfileDto, ProfileFont} from '../../../dtos/response/profile.dto';
import {CANVAS_COLUMNS, emptyCanvas} from '../../../models/profile-canvas';

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
    template: `
        <app-profile-canvas-editor
            [canvas]="editor.draft() ?? undefined"
            [editing]="editing()"
            [owner]="owner"
        />
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
class HostComponent {
    readonly editor = inject(CanvasEditorService);
    readonly editing = signal(true);
    readonly owner = OWNER;
}

function setup(canvas: ProfileCanvasDto = emptyCanvas('p1'), editing = true) {
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
    fixture.componentInstance.editing.set(editing);
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

    it('the Add widget affordance only appears in edit mode', () => {
        const editing = setup(emptyCanvas('p1'), true);
        expect(testId(editing.fixture, 'add-widget')).not.toBeNull();

        const viewing = setup(emptyCanvas('p1'), false);
        expect(testId(viewing.fixture, 'add-widget')).toBeNull();
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

    it('leaving edit mode clears the selection', () => {
        const {fixture} = setup(canvasOf([widget('w1')]));
        tile(fixture, 'w1').click();
        fixture.detectChanges();
        expect(testId(fixture, 'widget-editor-popover')).not.toBeNull();

        fixture.componentInstance.editing.set(false);
        fixture.detectChanges();

        expect(testId(fixture, 'widget-editor-popover')).toBeNull();
    });
});
