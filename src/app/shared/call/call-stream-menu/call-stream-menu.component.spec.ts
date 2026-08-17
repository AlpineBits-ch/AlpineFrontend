import {ComponentFixture, TestBed} from '@angular/core/testing';
import {beforeEach, describe, expect, it, afterEach} from 'vitest';
import {TranslateModule} from '@ngx-translate/core';
import {CallStreamMenuComponent} from './call-stream-menu.component';

let fixture: ComponentFixture<CallStreamMenuComponent>;

function setup(): ComponentFixture<CallStreamMenuComponent> {
    TestBed.configureTestingModule({
        imports: [CallStreamMenuComponent, TranslateModule.forRoot()],
    });
    fixture = TestBed.createComponent(CallStreamMenuComponent);
    fixture.componentRef.setInput('x', 120);
    fixture.componentRef.setInput('y', 240);
    // Attach to document so document:click listeners are genuinely reachable, not stopped by a
    // disconnected DOM tree. Tests for document:* listeners must append their fixture.
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    return fixture;
}

describe('CallStreamMenuComponent', () => {
    beforeEach(() => TestBed.resetTestingModule());

    afterEach(() => {
        fixture.nativeElement.remove();
    });

    it('positions itself at the click point', () => {
        const fixture = setup();

        const menu = fixture.nativeElement.querySelector('[data-testid="stream-menu"]') as HTMLElement;
        expect(menu.style.left).toBe('120px');
        expect(menu.style.top).toBe('240px');
    });

    it('emits showStats when the stats item is pressed', () => {
        const fixture = setup();
        let asked = false;
        fixture.componentInstance.showStats.subscribe(() => (asked = true));

        fixture.nativeElement.querySelector('[data-testid="menu-stats"]').click();

        expect(asked).toBe(true);
    });

    it('emits copyStats when the copy item is pressed', () => {
        const fixture = setup();
        let asked = false;
        fixture.componentInstance.copyStats.subscribe(() => (asked = true));

        fixture.nativeElement.querySelector('[data-testid="menu-copy"]').click();

        expect(asked).toBe(true);
    });

    it('closes on a document click', () => {
        const fixture = setup();
        let closed = false;
        fixture.componentInstance.close.subscribe(() => (closed = true));

        document.dispatchEvent(new MouseEvent('click'));

        expect(closed).toBe(true);
    });

    it('does not close on a click inside itself', () => {
        // The host stops propagation, so a press on an item never reaches the document listener.
        const fixture = setup();
        let closed = false;
        fixture.componentInstance.close.subscribe(() => (closed = true));

        fixture.nativeElement.querySelector('[data-testid="menu-stats"]')
            .dispatchEvent(new MouseEvent('click', {bubbles: true}));

        expect(closed).toBe(false);
    });

    it('closes on Escape', () => {
        const fixture = setup();
        let closed = false;
        fixture.componentInstance.close.subscribe(() => (closed = true));

        document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));

        expect(closed).toBe(true);
    });
});
