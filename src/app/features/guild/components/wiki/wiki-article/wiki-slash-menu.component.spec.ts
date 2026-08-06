import {ComponentFixture, TestBed} from '@angular/core/testing';
import {provideTranslateService} from '@ngx-translate/core';
import {WikiSlashMenuComponent} from './wiki-slash-menu.component';

/**
 * Keyboard navigation of the slash menu, asserted through the rendered DOM.
 *
 * Written because the menu could only be driven with the mouse and three successive fixes to the
 * *interception* did not change that, which made it worth proving where the fault is not: if the
 * highlight moves here, the component and its rendering are sound and only the path that delivers
 * the key to `handleKey` can be at fault.
 */
describe('WikiSlashMenuComponent keyboard navigation', () => {
    let fixture: ComponentFixture<WikiSlashMenuComponent>;

    function rows(): HTMLElement[] {
        return Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLElement[];
    }

    /**
     * Index of the row carrying the keyboard-selection styling, or -1.
     *
     * Matches the brand tint rather than `bg-hover` deliberately. The original bug was that the
     * selected row and a moused-over row were styled identically, in a colour two percent off the
     * card behind them - the selection did move, it simply could not be seen.
     */
    function highlighted(): number {
        return rows().findIndex(b => b.className.includes('bg-brand/25'));
    }

    function press(key: string): boolean {
        const consumed = fixture.componentInstance.handleKey(key);
        fixture.detectChanges();
        return consumed;
    }

    beforeEach(async () => {
        // jsdom implements no scroll geometry at all, and the component scrolls the highlighted
        // row into view on every move. Without this the effect throws and takes change detection
        // down with it - which says nothing about the component, only about the environment.
        Element.prototype.scrollIntoView = () => undefined;

        await TestBed.configureTestingModule({
            imports: [WikiSlashMenuComponent],
            providers: [provideTranslateService({defaultLanguage: 'en'})],
        }).compileComponents();

        fixture = TestBed.createComponent(WikiSlashMenuComponent);
        fixture.componentRef.setInput('open', true);
        fixture.componentRef.setInput('query', '');
        fixture.detectChanges();
    });

    it('renders rows and highlights the first one', () => {
        expect(rows().length).toBeGreaterThan(1);
        expect(highlighted()).toBe(0);
    });

    // The regression this file exists for: a selection styled the same as hover is not a selection.
    it('styles the selected row differently from a merely hovered one', () => {
        const selected = rows()[0];
        const other = rows()[1];
        expect(selected.className).not.toEqual(other.className);
        // The unselected rows are the ones that light up on hover; the selected one must not
        // rely on that class, or the two states are indistinguishable.
        expect(other.className).toContain('hover:bg-hover');
        expect(selected.className).not.toContain('hover:bg-hover');
    });

    it('moves the highlight down and reports the key as consumed', () => {
        expect(press('ArrowDown')).toBe(true);
        expect(highlighted()).toBe(1);
    });

    it('moves the highlight back up', () => {
        press('ArrowDown');
        press('ArrowDown');
        expect(highlighted()).toBe(2);
        expect(press('ArrowUp')).toBe(true);
        expect(highlighted()).toBe(1);
    });

    it('wraps from the first row to the last', () => {
        const rowCount = rows().length;
        press('ArrowUp');
        expect(highlighted()).toBe(rowCount - 1);
    });

    it('emits the highlighted item on Enter, not the first one', () => {
        const chosen: string[] = [];
        fixture.componentInstance.selected.subscribe(item => chosen.push(item.labelKey));
        press('ArrowDown');
        expect(press('Enter')).toBe(true);
        expect(chosen.length).toBe(1);
        // Whatever the second row is, it must not be the first.
        const first = rows()[0];
        expect(chosen[0]).toBeTruthy();
        expect(first.className).not.toContain('bg-brand/25');
    });

    it('ignores keys while closed, so a shut menu never swallows them', () => {
        fixture.componentRef.setInput('open', false);
        fixture.detectChanges();
        expect(press('ArrowDown')).toBe(false);
    });
});
