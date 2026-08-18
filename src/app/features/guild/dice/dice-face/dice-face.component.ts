import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {DieFace} from '../dice-roll-view';

/** The polygon each die size is drawn as. Anything unusual falls back to a circle. */
const POLYGONS: Readonly<Record<number, string>> = {
    4: '50,6 94,88 6,88',
    6: '10,10 90,10 90,90 10,90',
    8: '50,4 92,50 50,96 8,50',
    10: '50,4 94,36 77,90 23,90 6,36',
    12: '50,4 94,36 77,90 23,90 6,36',
    20: '50,4 91,27 91,73 50,96 9,73 9,27',
    100: '50,4 91,27 91,73 50,96 9,73 9,27',
};

/**
 * One die, drawn as the shape its size implies. Shape is what separates a d20 from a d6 at a
 * glance, and what makes a roll unmistakably a roll rather than a number somebody typed.
 */
@Component({
    selector: 'app-dice-face',
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <span
            [class.is-dropped]="!face().kept"
            [class.is-max]="face().isMax && face().kept"
            [class.is-min]="face().isMin && face().kept"
            [class]="'die die-' + size()"
            [attr.title]="face().exploded ? face().value : null"
        >
            <svg aria-hidden="true" class="die-shape" viewBox="0 0 100 100">
                @if (points(); as shape) {
                    <polygon [attr.points]="shape" />
                } @else {
                    <circle cx="50" cy="50" r="46" />
                }
            </svg>
            @if (!blank()) {
                <span class="die-value">{{ face().value }}</span>
            }
        </span>
    `,
    styleUrl: './dice-face.component.css',
})
export class DiceFaceComponent {
    readonly face = input.required<DieFace>();
    readonly sides = input<number>(6);
    readonly size = input<'sm' | 'lg'>('sm');
    /** An outline with no face, for the preview of an expression that has not been rolled. */
    readonly blank = input(false);

    protected readonly points = computed(() => POLYGONS[this.sides()] ?? null);
}
