import {NgTemplateOutlet} from '@angular/common';
import {
    afterNextRender,
    ChangeDetectionStrategy,
    Component,
    computed,
    contentChildren,
    DestroyRef,
    effect,
    ElementRef,
    inject,
    Injector,
    input,
    output,
    signal,
    viewChild,
    viewChildren,
} from '@angular/core';
import {
    placeAtPoint,
    placeBelowAnchor,
    placeSubmenu,
    Size,
    VIEWPORT_MARGIN,
    Viewport,
} from './context-menu-position';
import {isSelectable, MenuItem, normalizeItems} from './context-menu.model';
import {MenuSlotDirective} from './menu-slot.directive';

interface Panel {
    readonly id: number;
    readonly items: MenuItem[];
    /** Index of the row in the panel above that opened this one. Null for the root. */
    readonly fromIndex: number | null;
}

type Origin = {kind: 'point'; x: number; y: number} | {kind: 'anchor'; element: HTMLElement};

/** How long the pointer rests on a parent row before its submenu opens. */
const SUBMENU_OPEN_DELAY = 110;
/** Grace period before a submenu closes, so a diagonal move into it does not lose it. */
const SUBMENU_CLOSE_DELAY = 200;
const TYPEAHEAD_RESET = 600;

/**
 * The element a dropdown hangs off. `currentTarget` is null once an Angular output has
 * re-emitted a DOM event, which leaves the icon inside the button as the only clue.
 */
function anchorOf(event: MouseEvent): HTMLElement {
    const current = event.currentTarget as HTMLElement | null;
    if (current) return current;
    const target = event.target as HTMLElement;
    return target.closest<HTMLElement>('button, a, [role="button"]') ?? target;
}

@Component({
    selector: 'app-context-menu',
    imports: [NgTemplateOutlet],
    templateUrl: './context-menu.component.html',
    styleUrl: './context-menu.component.css',
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContextMenuComponent {
    /** Rows used when `show()` is called without its own. */
    readonly model = input<MenuItem[]>([]);

    readonly opened = output<void>();
    readonly closed = output<void>();

    private readonly root = viewChild<ElementRef<HTMLElement>>('root');
    private readonly panelEls = viewChildren<ElementRef<HTMLElement>>('panelEl');
    private readonly slots = contentChildren(MenuSlotDirective);

    protected readonly panels = signal<Panel[]>([]);
    protected readonly active = signal<{panel: number; index: number} | null>(null);

    readonly isOpen = computed(() => this.panels().length > 0);

    private readonly injector = inject(Injector);
    private nextPanelId = 0;
    private popoverShown = false;
    private origin: Origin | null = null;
    private restoreFocusTo: HTMLElement | null = null;
    private openTimer?: ReturnType<typeof setTimeout>;
    private closeTimer?: ReturnType<typeof setTimeout>;
    private typeahead = '';
    private typeaheadTimer?: ReturnType<typeof setTimeout>;

    constructor() {
        inject(DestroyRef).onDestroy(() => {
            this.clearTimers();
            this.detachDismissListeners();
        });

        // Pointer and keyboard share one highlight, so DOM focus follows `active` either way.
        effect(() => {
            const target = this.active();
            const panels = this.panelEls();
            if (!target) return;
            const row = panels[target.panel]?.nativeElement.querySelector<HTMLElement>(
                '[data-index="' + target.index + '"]',
            );
            if (row && document.activeElement !== row) row.focus({preventScroll: true});
        });
    }

    // ── Public API ───────────────────────────────────────────────────────────

    /** Opens at the pointer. `items` overrides the bound model for this opening only. */
    show(event: MouseEvent, items?: MenuItem[]): void {
        event.preventDefault();
        event.stopPropagation();
        this.open({kind: 'point', x: event.clientX, y: event.clientY}, items);
    }

    /** Opens under the element the event came from, the way a button dropdown does. */
    toggle(event: MouseEvent, items?: MenuItem[]): void {
        if (this.isOpen()) {
            this.hide();
            return;
        }
        this.open({kind: 'anchor', element: anchorOf(event)}, items);
    }

    hide(): void {
        if (!this.isOpen()) return;
        this.clearTimers();
        this.detachDismissListeners();
        this.panels.set([]);
        this.active.set(null);
        this.origin = null;

        if (this.popoverShown) {
            this.root()?.nativeElement.hidePopover?.();
            this.popoverShown = false;
        }

        const restore = this.restoreFocusTo;
        this.restoreFocusTo = null;
        if (restore?.isConnected) restore.focus({preventScroll: true});

        this.closed.emit();
    }

    private open(origin: Origin, items?: MenuItem[]): void {
        const rows = normalizeItems(items ?? this.model());
        if (rows.length === 0) return;

        this.clearTimers();
        this.origin = origin;
        this.restoreFocusTo ??= document.activeElement as HTMLElement | null;
        this.active.set(null);
        this.panels.set([{id: this.nextPanelId++, items: rows, fromIndex: null}]);

        if (!this.popoverShown) {
            this.root()?.nativeElement.showPopover?.();
            this.popoverShown = true;
        }

        this.placeAfterRender(0);
        this.attachDismissListeners();
        this.opened.emit();
    }

    // ── Placement ────────────────────────────────────────────────────────────

    /** Panels are measured before they are painted, so no row moves after the first frame. */
    private placeAfterRender(index: number, focusFirstRow = false): void {
        afterNextRender(
            () => {
                const element = this.panelEls()[index]?.nativeElement;
                if (!element) return;

                const viewport: Viewport = {width: window.innerWidth, height: window.innerHeight};
                const size: Size = {width: element.offsetWidth, height: element.offsetHeight};
                const placement =
                    index === 0 ? this.placeRoot(size, viewport) : this.placeChild(index, size, viewport);
                if (!placement) return;

                element.style.left = placement.x + 'px';
                element.style.top = placement.y + 'px';
                element.style.transformOrigin = placement.originX + ' ' + placement.originY;
                element.dataset['placed'] = 'true';

                if (focusFirstRow) this.focusFirst(index);
            },
            {injector: this.injector},
        );
    }

    private placeRoot(size: Size, viewport: Viewport) {
        const origin = this.origin;
        if (!origin) return null;
        if (origin.kind === 'point') return placeAtPoint(origin.x, origin.y, size, viewport);
        return placeBelowAnchor(origin.element.getBoundingClientRect(), size, viewport);
    }

    private placeChild(index: number, size: Size, viewport: Viewport) {
        const parent = this.panelEls()[index - 1]?.nativeElement;
        const fromIndex = this.panels()[index]?.fromIndex;
        if (!parent || fromIndex === null || fromIndex === undefined) return null;

        const row = parent.querySelector<HTMLElement>('[data-index="' + fromIndex + '"]');
        if (!row) return null;

        const padding = parseFloat(getComputedStyle(parent).paddingTop) || 0;
        return placeSubmenu(
            parent.getBoundingClientRect(),
            row.getBoundingClientRect(),
            padding,
            size,
            viewport,
            VIEWPORT_MARGIN,
        );
    }

    // ── Rows ─────────────────────────────────────────────────────────────────

    protected slotTemplate(name: string) {
        return this.slots().find(slot => slot.name() === name)?.template ?? null;
    }

    protected itemClass(item: MenuItem): string {
        const classes = ['cm-item'];
        if (item.danger) classes.push('cm-item--danger');
        if (item.disabled) classes.push('cm-item--disabled');
        if (item.styleClass) classes.push(item.styleClass);
        return classes.join(' ');
    }

    protected isActive(panel: number, index: number): boolean {
        const active = this.active();
        return active?.panel === panel && active.index === index;
    }

    protected hasSubmenu(item: MenuItem): boolean {
        return (item.items?.length ?? 0) > 0;
    }

    protected isExpanded(panel: number, index: number): boolean {
        return this.panels()[panel + 1]?.fromIndex === index;
    }

    protected onRowEnter(event: PointerEvent, panel: number, index: number): void {
        const item = this.panels()[panel]?.items[index];
        if (!item || !isSelectable(item)) return;

        clearTimeout(this.openTimer);
        this.active.set({panel, index});
        item.hover?.({originalEvent: event, item});

        if (this.hasSubmenu(item)) {
            clearTimeout(this.closeTimer);
            if (this.isExpanded(panel, index)) return;
            this.openTimer = setTimeout(() => this.openSubmenu(panel, index), SUBMENU_OPEN_DELAY);
            return;
        }

        // A row without children only closes what is deeper after a grace period: a diagonal
        // move towards an open submenu crosses rows it does not mean to select.
        if (this.panels().length > panel + 1) {
            clearTimeout(this.closeTimer);
            this.closeTimer = setTimeout(() => this.closeDeeperThan(panel), SUBMENU_CLOSE_DELAY);
        }
    }

    protected onPanelEnter(panel: number): void {
        if (panel > 0) clearTimeout(this.closeTimer);
    }

    protected onRowClick(event: MouseEvent, panel: number, index: number): void {
        const item = this.panels()[panel]?.items[index];
        if (!item || !isSelectable(item)) return;

        if (this.hasSubmenu(item)) {
            event.stopPropagation();
            clearTimeout(this.openTimer);
            if (!this.isExpanded(panel, index)) this.openSubmenu(panel, index);
            return;
        }

        // Slot rows own their content; a click landing on something interactive inside one is
        // not a row activation.
        if (item.slot && event.target !== event.currentTarget) return;

        this.activate(item, event);
    }

    private activate(item: MenuItem, originalEvent?: Event): void {
        this.hide();
        item.command?.({originalEvent, item});
    }

    private openSubmenu(panel: number, index: number, focusFirstRow = false): void {
        const item = this.panels()[panel]?.items[index];
        const children = normalizeItems(item?.items ?? []);
        if (children.length === 0) return;

        this.panels.update(panels => [
            ...panels.slice(0, panel + 1),
            {id: this.nextPanelId++, items: children, fromIndex: index},
        ]);
        this.placeAfterRender(panel + 1, focusFirstRow);
    }

    private closeDeeperThan(panel: number): void {
        if (this.panels().length <= panel + 1) return;
        this.panels.update(panels => panels.slice(0, panel + 1));
        const active = this.active();
        if (active && active.panel > panel) this.active.set({panel, index: active.index});
    }

    // ── Keyboard ─────────────────────────────────────────────────────────────

    protected onKeydown(event: KeyboardEvent): void {
        const depth = this.panels().length - 1;
        if (depth < 0) return;
        const panel = this.active()?.panel ?? depth;

        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                this.step(panel, 1);
                return;
            case 'ArrowUp':
                event.preventDefault();
                this.step(panel, -1);
                return;
            case 'Home':
                event.preventDefault();
                this.focusFirst(panel);
                return;
            case 'End':
                event.preventDefault();
                this.focusLast(panel);
                return;
            case 'ArrowRight':
                event.preventDefault();
                this.enterSubmenu(panel);
                return;
            case 'ArrowLeft':
                event.preventDefault();
                if (depth > 0) this.leaveSubmenu(depth);
                return;
            case 'Enter':
            case ' ':
                event.preventDefault();
                this.activateActive(event);
                return;
            case 'Escape':
                event.preventDefault();
                event.stopPropagation();
                if (depth > 0) this.leaveSubmenu(depth);
                else this.hide();
                return;
            case 'Tab':
                this.hide();
                return;
        }

        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            this.jumpTo(panel, event.key);
        }
    }

    private step(panel: number, delta: number): void {
        const items = this.panels()[panel]?.items ?? [];
        const count = items.length;
        if (count === 0) return;
        const active = this.active();
        const current = active?.panel === panel ? active.index : delta > 0 ? -1 : 0;

        for (let hop = 1; hop <= count; hop++) {
            const next = (((current + delta * hop) % count) + count) % count;
            if (isSelectable(items[next])) {
                this.closeDeeperThan(panel);
                this.active.set({panel, index: next});
                return;
            }
        }
    }

    private focusFirst(panel: number): void {
        const items = this.panels()[panel]?.items ?? [];
        const index = items.findIndex(isSelectable);
        if (index >= 0) this.active.set({panel, index});
    }

    private focusLast(panel: number): void {
        const items = this.panels()[panel]?.items ?? [];
        for (let i = items.length - 1; i >= 0; i--) {
            if (isSelectable(items[i])) {
                this.active.set({panel, index: i});
                return;
            }
        }
    }

    private enterSubmenu(panel: number): void {
        const active = this.active();
        if (!active) return;
        const item = this.panels()[panel]?.items[active.index];
        if (!item || !this.hasSubmenu(item)) return;
        if (this.isExpanded(panel, active.index)) this.focusFirst(panel + 1);
        else this.openSubmenu(panel, active.index, true);
    }

    private leaveSubmenu(panel: number): void {
        const fromIndex = this.panels()[panel]?.fromIndex;
        this.closeDeeperThan(panel - 1);
        if (fromIndex !== null && fromIndex !== undefined) {
            this.active.set({panel: panel - 1, index: fromIndex});
        }
    }

    private activateActive(event: KeyboardEvent): void {
        const active = this.active();
        if (!active) return;
        const item = this.panels()[active.panel]?.items[active.index];
        if (!item || !isSelectable(item)) return;
        if (this.hasSubmenu(item)) {
            this.enterSubmenu(active.panel);
            return;
        }
        this.activate(item, event);
    }

    private jumpTo(panel: number, character: string): void {
        clearTimeout(this.typeaheadTimer);
        this.typeahead += character.toLowerCase();
        this.typeaheadTimer = setTimeout(() => (this.typeahead = ''), TYPEAHEAD_RESET);

        const items = this.panels()[panel]?.items ?? [];
        const index = items.findIndex(
            item => isSelectable(item) && item.label?.toLowerCase().startsWith(this.typeahead),
        );
        if (index >= 0) {
            this.closeDeeperThan(panel);
            this.active.set({panel, index});
        }
    }

    // ── Dismissal ────────────────────────────────────────────────────────────

    private readonly onDocumentPointerDown = (event: Event): void => {
        if (this.containsTarget(event.target)) return;
        this.hide();
    };

    private readonly onViewportChange = (event: Event): void => {
        // Scrolling inside the menu is not a reason to close it.
        if (event.type === 'scroll' && this.containsTarget(event.target)) {
            this.closeDeeperThan(0);
            return;
        }
        this.hide();
    };

    private containsTarget(target: EventTarget | null): boolean {
        const node = target as Node | null;
        if (!node) return false;
        if (this.root()?.nativeElement.contains(node)) return true;
        const origin = this.origin;
        return origin?.kind === 'anchor' && origin.element.contains(node);
    }

    private attachDismissListeners(): void {
        document.addEventListener('pointerdown', this.onDocumentPointerDown, true);
        document.addEventListener('scroll', this.onViewportChange, true);
        window.addEventListener('resize', this.onViewportChange);
        window.addEventListener('blur', this.onViewportChange);
    }

    private detachDismissListeners(): void {
        document.removeEventListener('pointerdown', this.onDocumentPointerDown, true);
        document.removeEventListener('scroll', this.onViewportChange, true);
        window.removeEventListener('resize', this.onViewportChange);
        window.removeEventListener('blur', this.onViewportChange);
    }

    private clearTimers(): void {
        clearTimeout(this.openTimer);
        clearTimeout(this.closeTimer);
        clearTimeout(this.typeaheadTimer);
        this.typeahead = '';
    }
}
