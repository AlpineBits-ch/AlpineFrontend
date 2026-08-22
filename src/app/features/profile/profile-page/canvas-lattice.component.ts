import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';

/**
 * The snap grid, shown only while arranging. Same column formula and gap as the widget grid, so its
 * tracks land on the same column boundaries rather than an independent approximation of them.
 * `rowHeights` carries one measured pixel height per row rather than a row count: the widget grid
 * sets no `grid-auto-rows`, so a row is as tall as its content, never a square guess.
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
            @for (height of cells(); track $index) {
                <div
                    [style.height.px]="height"
                    class="rounded-md border border-brand/20 bg-brand/[0.04]"
                ></div>
            }
        </div>
    `,
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CanvasLatticeComponent {
    readonly columns = input.required<number>();
    readonly rowHeights = input.required<readonly number[]>();
    readonly active = input.required<boolean>();

    protected readonly cells = computed(() => {
        const columns = this.columns();
        return this.rowHeights().flatMap(height => Array.from({length: columns}, () => height));
    });
}
