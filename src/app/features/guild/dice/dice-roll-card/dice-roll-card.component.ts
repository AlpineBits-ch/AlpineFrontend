import {
    ChangeDetectionStrategy,
    Component,
    computed,
    DestroyRef,
    inject,
    input,
    OnInit,
    signal,
} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {DiceFaceComponent} from '../dice-face/dice-face.component';
import {DiceRollView} from '../dice-roll-view';

/** How long the total takes to arrive at its value. Short enough to feel physical, not theatrical. */
const COUNT_MS = 260;

/**
 * A recorded roll. Dice are drawn as shapes rather than digits, so a result cannot be mistaken for
 * something a player typed - which is the entire reason rolls are made on the server.
 */
@Component({
    selector: 'app-dice-roll-card',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [TranslateModule, DiceFaceComponent],
    templateUrl: './dice-roll-card.component.html',
    styleUrl: './dice-roll-card.component.css',
})
export class DiceRollCardComponent implements OnInit {
    readonly roll = input.required<DiceRollView>();
    /** Set for a roll that arrived just now. Scrollback renders at its final value immediately. */
    readonly settling = input(false);

    private readonly destroyRef = inject(DestroyRef);

    private readonly counted = signal<number | null>(null);

    protected readonly total = computed(() => this.counted() ?? this.roll().total);

    /** Terms that rolled dice; a bare constant is drawn as a chip beside them instead. */
    protected readonly pools = computed(() => this.roll().terms.filter(term => term.faces.length > 0));

    protected readonly constants = computed(() =>
        this.roll().terms.filter(term => term.faces.length === 0 && term.constant !== null),
    );

    // Counting up is the only place a number moves in this client, and it moves once.
    ngOnInit(): void {
        if (!this.settling() || prefersReducedMotion()) return;
        const target = this.roll().total;
        if (target === 0) return;

        const from = performance.now();
        let frame = 0;
        const tick = () => {
            const progress = Math.min((performance.now() - from) / COUNT_MS, 1);
            this.counted.set(Math.round(target * easeOut(progress)));
            if (progress < 1) frame = requestAnimationFrame(tick);
            else this.counted.set(null);
        };
        frame = requestAnimationFrame(tick);
        this.destroyRef.onDestroy(() => cancelAnimationFrame(frame));
    }

    /** Staggered so the dice land one after another rather than all at once. */
    protected delay(index: number): string {
        return this.settling() ? `${index * 45}ms` : '0ms';
    }
}

function easeOut(t: number): number {
    return 1 - Math.pow(1 - t, 3);
}

function prefersReducedMotion(): boolean {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}
