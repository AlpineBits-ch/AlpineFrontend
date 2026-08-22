import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';

/**
 * The snap grid, shown only while arranging. Same column formula and gap as the widget grid, so
 * its tracks land on the same pixel boundaries rather than an independent approximation of them.
 */
@Component({
    selector: 'app-canvas-lattice',
    template: `
        <div
            [class.opacity-0]="!active()"
            [class.opacity-100]="active()"
            [style.grid-template-columns]="'repeat(' + columns() + ', minmax(0, 1fr))'"
            aria-hidden="true"
            class="grid gap-2 transition-opacity duration-200 ease-out motion-reduce:transition-none"
            data-testid="canvas-lattice"
        >
            @for (cell of cells(); track $index) {
                <div class="aspect-square rounded-md border border-brand/20 bg-brand/[0.04]"></div>
            }
        </div>
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CanvasLatticeComponent {
    readonly columns = input.required<number>();
    readonly rows = input.required<number>();
    readonly active = input.required<boolean>();

    protected readonly cells = computed(() => Array.from({length: this.columns() * this.rows()}));
}
