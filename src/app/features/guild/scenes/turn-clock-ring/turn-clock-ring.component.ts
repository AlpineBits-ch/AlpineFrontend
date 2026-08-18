import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {PersonaAvatarComponent} from '../../personas/persona-avatar/persona-avatar.component';
import {PersonaIdentity} from '../../personas/persona-identity';
import {TurnClock} from '../scene-clock';

type RingSize = 'sm' | 'md' | 'lg';

/**
 * The gap between the avatar and the arc is deliberate and generous: the avatar carries the
 * character's colour on its own ring, and the two read as one thick band when they touch.
 */
const BOX: Record<RingSize, {box: number; inset: number; stroke: number; avatar: 'sm' | 'md' | 'lg'}> = {
    sm: {box: 42, inset: 7, stroke: 2, avatar: 'sm'},
    md: {box: 46, inset: 7, stroke: 2, avatar: 'md'},
    lg: {box: 66, inset: 9, stroke: 2.5, avatar: 'lg'},
};

/**
 * A character's face with the turn's clock drawn around it. The inner ring is who, the outer arc
 * is when: the arc drains as the turn is spent and takes no colour of its own, so the only loud
 * thing on screen stays "waiting on you".
 */
@Component({
    selector: 'app-turn-clock-ring',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [PersonaAvatarComponent],
    template: `
        <span
            [style.height.px]="metrics().box"
            [style.width.px]="metrics().box"
            class="relative inline-flex shrink-0"
        >
            <svg
                [attr.viewBox]="'0 0 ' + metrics().box + ' ' + metrics().box"
                class="pointer-events-none absolute inset-0 -rotate-90"
                aria-hidden="true"
            >
                <circle
                    [attr.cx]="centre()"
                    [attr.cy]="centre()"
                    [attr.r]="radius()"
                    [attr.stroke-dasharray]="overdue() ? '2 4' : null"
                    [attr.stroke-width]="metrics().stroke"
                    fill="none"
                    stroke="rgba(255,255,255,0.14)"
                />
                @if (dashOffset() !== null) {
                    <circle
                        [attr.cx]="centre()"
                        [attr.cy]="centre()"
                        [attr.r]="radius()"
                        [attr.stroke-dasharray]="circumference()"
                        [attr.stroke-dashoffset]="dashOffset()"
                        [attr.stroke-width]="metrics().stroke"
                        [attr.stroke]="arcColor()"
                        fill="none"
                        stroke-linecap="round"
                    />
                }
            </svg>
            <span [style.inset.px]="metrics().inset" class="absolute">
                <app-persona-avatar
                    [avatarUrl]="identity()?.avatarUrl ?? null"
                    [color]="identity()?.color ?? null"
                    [muted]="muted()"
                    [name]="identity()?.name ?? ''"
                    [size]="metrics().avatar"
                />
            </span>
        </span>
    `,
})
export class TurnClockRingComponent {
    readonly identity = input<PersonaIdentity | null>(null);
    readonly clock = input<TurnClock | null>(null);
    readonly size = input<RingSize>('lg');
    readonly muted = input(false);

    protected readonly metrics = computed(() => BOX[this.size()]);
    protected readonly centre = computed(() => this.metrics().box / 2);
    protected readonly radius = computed(() => this.centre() - this.metrics().stroke / 2 - 1);
    protected readonly circumference = computed(() => 2 * Math.PI * this.radius());

    protected readonly overdue = computed(() => !!this.clock()?.overdue);

    /**
     * How much of the arc is drawn. Null when there is no clock at all, and also when the turn's
     * start is unknown: a proportion nobody can compute must not be invented.
     */
    protected readonly dashOffset = computed((): number | null => {
        const clock = this.clock();
        if (!clock?.hasDeadline || clock.overdue) return null;
        if (clock.spent === null) return 0;
        return this.circumference() * clock.spent;
    });

    protected readonly arcColor = computed(
        () => this.identity()?.color ?? 'color-mix(in srgb, var(--color-text-secondary) 60%, transparent)',
    );
}
