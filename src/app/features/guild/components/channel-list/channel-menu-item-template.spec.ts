/**
 * The assumption the channel context menu is built on: Invite People carries no `command` (it opens on hover instead), so the menu draws its own items via `pTemplate="item"`, replacing only the link inside each row. Every other entry still relies on PrimeNG putting the click on the row around the link, not the link itself.
 * This pins that down: if PrimeNG ever moves the click onto the link, four working menu entries go quiet at once and nothing else in the suite would notice.
 */
import {Component, signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {MenuItem, PrimeTemplate} from 'primeng/api';
import {Menu} from 'primeng/menu';

@Component({
    imports: [Menu, PrimeTemplate],
    template: `
        <p-menu [model]="items()">
            <ng-template let-item pTemplate="item">
                <a class="p-menu-item-link">
                    <span class="p-menu-item-label">{{ item.label }}</span>
                </a>
            </ng-template>
        </p-menu>
    `,
})
class HostComponent {
    readonly ran = signal<string[]>([]);
    readonly items = signal<MenuItem[]>([
        {id: 'invite', label: 'Invite People'},
        {label: 'Edit Channel', command: () => this.ran.update(r => [...r, 'edit'])},
    ]);
}

describe('a p-menu with a custom item template', () => {
    afterEach(() => TestBed.resetTestingModule());

    function setup() {
        const fixture = TestBed.createComponent(HostComponent);
        fixture.detectChanges();
        return fixture;
    }

    function clickLabelled(fixture: ReturnType<typeof setup>, label: string): void {
        const link = [...fixture.nativeElement.querySelectorAll('.p-menu-item-link')]
            .find((el): el is HTMLElement => (el as HTMLElement).textContent?.trim() === label);
        link?.click();
        fixture.detectChanges();
    }

    it('still runs an item command when the template draws the link', () => {
        const fixture = setup();

        clickLabelled(fixture, 'Edit Channel');

        expect(fixture.componentInstance.ran()).toEqual(['edit']);
    });

    it('runs nothing for an item that carries no command, which is how Invite opts out', () => {
        const fixture = setup();

        clickLabelled(fixture, 'Invite People');

        expect(fixture.componentInstance.ran()).toEqual([]);
    });
});
