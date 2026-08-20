import {ChangeDetectionStrategy, Component, viewChild} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {ContextMenuComponent} from './context-menu.component';
import {MenuItem, MenuItemCommandEvent, normalizeItems} from './context-menu.model';
import {MenuSlotDirective} from './menu-slot.directive';

function setup(items: MenuItem[]) {
    TestBed.configureTestingModule({imports: [ContextMenuComponent]});
    const fixture: ComponentFixture<ContextMenuComponent> = TestBed.createComponent(ContextMenuComponent);
    fixture.componentRef.setInput('model', items);
    fixture.detectChanges();
    return fixture;
}

function rightClick(): MouseEvent {
    return new MouseEvent('contextmenu', {clientX: 40, clientY: 60, bubbles: true});
}

function rows(fixture: ComponentFixture<ContextMenuComponent>): HTMLElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('[role="menuitem"]'));
}

function panels(fixture: ComponentFixture<ContextMenuComponent>): HTMLElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('[role="menu"]'));
}

function press(fixture: ComponentFixture<ContextMenuComponent>, key: string): void {
    fixture.nativeElement
        .querySelector('.cm-root')
        .dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true}));
    fixture.detectChanges();
}

function labels(fixture: ComponentFixture<ContextMenuComponent>): (string | undefined)[] {
    return rows(fixture).map(row => row.querySelector('.cm-label')?.textContent?.trim());
}

function activeLabel(fixture: ComponentFixture<ContextMenuComponent>): string | undefined {
    return fixture.nativeElement.querySelector('.is-active .cm-label')?.textContent?.trim();
}

describe('normalizeItems', () => {
    it('drops hidden rows', () => {
        const items = normalizeItems([{label: 'Keep'}, {label: 'Gone', visible: false}]);

        expect(items.map(i => i.label)).toEqual(['Keep']);
    });

    it('collapses a separator left doubled by a hidden row', () => {
        const items = normalizeItems([
            {label: 'A'},
            {separator: true},
            {label: 'B', visible: false},
            {separator: true},
            {label: 'C'},
        ]);

        expect(items.map(i => i.label ?? 'sep')).toEqual(['A', 'sep', 'C']);
    });

    it('drops leading and trailing separators', () => {
        const items = normalizeItems([{separator: true}, {label: 'A'}, {separator: true}]);

        expect(items).toHaveLength(1);
    });
});

describe('ContextMenuComponent', () => {
    let command: Mock<(event: MenuItemCommandEvent) => void>;
    let model: MenuItem[];

    beforeEach(() => {
        command = vi.fn<(event: MenuItemCommandEvent) => void>();
        model = [
            {label: 'Open', icon: 'pi pi-comment', command},
            {separator: true},
            {label: 'Muted', disabled: true},
            {
                label: 'Timeout',
                items: [{label: '60 seconds'}, {label: '5 minutes'}],
            },
            {label: 'Delete', danger: true, key: 'Del'},
        ];
    });

    it('renders nothing until it is shown', () => {
        const fixture = setup(model);

        expect(fixture.componentInstance.isOpen()).toBe(false);
        expect(rows(fixture)).toHaveLength(0);
    });

    it('opens on show and renders the bound model', () => {
        const fixture = setup(model);

        fixture.componentInstance.show(rightClick());
        fixture.detectChanges();

        expect(fixture.componentInstance.isOpen()).toBe(true);
        expect(labels(fixture)).toEqual(['Open', 'Muted', 'Timeout', 'Delete']);
    });

    it('prefers items passed to show over the bound model', () => {
        const fixture = setup(model);

        fixture.componentInstance.show(rightClick(), [{label: 'Only this'}]);
        fixture.detectChanges();

        expect(labels(fixture)).toEqual(['Only this']);
    });

    it('runs the command and closes when a row is clicked', () => {
        const fixture = setup(model);
        fixture.componentInstance.show(rightClick());
        fixture.detectChanges();

        rows(fixture)[0].click();
        fixture.detectChanges();

        expect(command).toHaveBeenCalledOnce();
        expect(fixture.componentInstance.isOpen()).toBe(false);
    });

    it('ignores a click on a disabled row', () => {
        const fixture = setup(model);
        fixture.componentInstance.show(rightClick());
        fixture.detectChanges();

        rows(fixture)[1].click();
        fixture.detectChanges();

        expect(fixture.componentInstance.isOpen()).toBe(true);
    });

    it('skips separators and disabled rows when arrowing down', () => {
        const fixture = setup(model);
        fixture.componentInstance.show(rightClick());
        fixture.detectChanges();

        press(fixture, 'ArrowDown');
        expect(activeLabel(fixture)).toBe('Open');

        press(fixture, 'ArrowDown');
        expect(activeLabel(fixture)).toBe('Timeout');
    });

    it('wraps from the last row back to the first', () => {
        const fixture = setup(model);
        fixture.componentInstance.show(rightClick());
        fixture.detectChanges();

        press(fixture, 'End');
        expect(activeLabel(fixture)).toBe('Delete');

        press(fixture, 'ArrowDown');
        expect(activeLabel(fixture)).toBe('Open');
    });

    it('jumps to a row by typing its first letter', () => {
        const fixture = setup(model);
        fixture.componentInstance.show(rightClick());
        fixture.detectChanges();

        press(fixture, 'd');

        expect(activeLabel(fixture)).toBe('Delete');
    });

    it('opens a submenu on ArrowRight and focuses its first row', () => {
        const fixture = setup(model);
        fixture.componentInstance.show(rightClick());
        fixture.detectChanges();

        press(fixture, 't');
        press(fixture, 'ArrowRight');

        expect(panels(fixture)).toHaveLength(2);
        expect(labels(fixture)).toContain('60 seconds');
    });

    it('closes only the submenu on the first Escape', () => {
        const fixture = setup(model);
        fixture.componentInstance.show(rightClick());
        fixture.detectChanges();

        press(fixture, 't');
        press(fixture, 'ArrowRight');
        press(fixture, 'Escape');

        expect(panels(fixture)).toHaveLength(1);
        expect(fixture.componentInstance.isOpen()).toBe(true);

        press(fixture, 'Escape');
        expect(fixture.componentInstance.isOpen()).toBe(false);
    });

    it('marks a parent row as expanded while its submenu is open', () => {
        const fixture = setup(model);
        fixture.componentInstance.show(rightClick());
        fixture.detectChanges();

        const timeout = rows(fixture)[2];
        expect(timeout.getAttribute('aria-haspopup')).toBe('menu');
        expect(timeout.getAttribute('aria-expanded')).toBe('false');

        timeout.click();
        fixture.detectChanges();

        expect(rows(fixture)[2].getAttribute('aria-expanded')).toBe('true');
    });

    it('fires the hover callback when the pointer enters a row that reveals a panel', () => {
        const hover = vi.fn<(event: MenuItemCommandEvent) => void>();
        const fixture = setup([{label: 'Invite People', chevron: true, hover}]);
        fixture.componentInstance.show(rightClick());
        fixture.detectChanges();

        rows(fixture)[0].dispatchEvent(new PointerEvent('pointerenter', {bubbles: true}));

        expect(hover).toHaveBeenCalledOnce();
        expect(fixture.componentInstance.isOpen()).toBe(true);
    });

    it('draws the arrow on a chevron row that has no submenu of its own', () => {
        const fixture = setup([{label: 'Invite People', chevron: true}]);
        fixture.componentInstance.show(rightClick());
        fixture.detectChanges();

        expect(rows(fixture)[0].querySelector('.cm-chevron')).not.toBeNull();
        expect(panels(fixture)).toHaveLength(1);
    });

    it('does nothing when a row without a command is clicked', () => {
        const fixture = setup([{label: 'Inert'}]);
        fixture.componentInstance.show(rightClick());
        fixture.detectChanges();

        rows(fixture)[0].click();
        fixture.detectChanges();

        expect(fixture.componentInstance.isOpen()).toBe(false);
    });

    it('leaves the highlight on the parent row when hover opens a submenu', () => {
        const fixture = setup(model);
        fixture.componentInstance.show(rightClick());
        fixture.detectChanges();

        rows(fixture)[2].dispatchEvent(new PointerEvent('pointerenter', {bubbles: true}));
        fixture.detectChanges();
        rows(fixture)[2].click();
        fixture.detectChanges();

        expect(panels(fixture)).toHaveLength(2);
        expect(activeLabel(fixture)).toBe('Timeout');
    });

    it('closes a hover-opened submenu on Escape before closing itself', () => {
        const fixture = setup(model);
        fixture.componentInstance.show(rightClick());
        fixture.detectChanges();

        rows(fixture)[2].click();
        fixture.detectChanges();
        expect(panels(fixture)).toHaveLength(2);

        press(fixture, 'Escape');

        expect(panels(fixture)).toHaveLength(1);
        expect(fixture.componentInstance.isOpen()).toBe(true);
    });

    it('closes on a pointerdown outside itself', () => {
        const fixture = setup(model);
        fixture.componentInstance.show(rightClick());
        fixture.detectChanges();

        document.body.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
        fixture.detectChanges();

        expect(fixture.componentInstance.isOpen()).toBe(false);
    });

    it('stays open when the pointer goes down inside itself', () => {
        const fixture = setup(model);
        fixture.componentInstance.show(rightClick());
        fixture.detectChanges();

        rows(fixture)[0].dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}));
        fixture.detectChanges();

        expect(fixture.componentInstance.isOpen()).toBe(true);
    });

    it('does not open when every row is hidden', () => {
        const fixture = setup([{label: 'Nope', visible: false}]);

        fixture.componentInstance.show(rightClick());
        fixture.detectChanges();

        expect(fixture.componentInstance.isOpen()).toBe(false);
    });
});

@Component({
    imports: [ContextMenuComponent, MenuSlotDirective],
    template: `
        <app-context-menu #menu>
            <ng-template appMenuSlot="volume" let-item>
                <input [attr.aria-label]="item.label" type="range" />
            </ng-template>
        </app-context-menu>
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
class SlotHostComponent {
    readonly menu = viewChild.required<ContextMenuComponent>('menu');
}

describe('a menu row filled by a consumer template', () => {
    function slotHost() {
        TestBed.configureTestingModule({imports: [SlotHostComponent]});
        const fixture = TestBed.createComponent(SlotHostComponent);
        fixture.detectChanges();
        fixture.componentInstance.menu().show(rightClick(), [{label: 'Volume', slot: 'volume'}]);
        fixture.detectChanges();
        return fixture;
    }

    it('renders the template inside a row the keyboard can still reach', () => {
        const fixture = slotHost();
        const row: HTMLElement = fixture.nativeElement.querySelector('[role="menuitem"]');

        expect(row).not.toBeNull();
        expect(row.classList.contains('cm-item')).toBe(true);
        expect(row.classList.contains('cm-item--slot')).toBe(true);
        expect(row.querySelector('input[type="range"]')).not.toBeNull();
    });

    it('does not treat a click on the template content as picking the row', () => {
        const fixture = slotHost();
        const slider: HTMLInputElement = fixture.nativeElement.querySelector('input[type="range"]');

        slider.click();
        fixture.detectChanges();

        expect(fixture.componentInstance.menu().isOpen()).toBe(true);
    });
});
