/**
 * The assumption the channel context menu is built on.
 *
 * <p>Its Invite People entry carries no `command`: it opens a panel on hover, which a command
 * cannot express, so the menu draws its own items through `pTemplate="item"`. That template
 * replaces the link inside each row - and every other entry in that menu (Edit Channel, Create
 * Invite, Copy Channel ID, Delete Channel) still relies on PrimeNG running its `command` and
 * closing the menu.</p>
 *
 * <p>That works because PrimeNG puts the click on the row around the link rather than on the link
 * itself. This pins that down: if it ever moves onto the link, four working menu entries go quiet
 * at once and nothing else in the suite would notice.</p>
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
