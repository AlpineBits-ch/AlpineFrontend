import {ChangeDetectionStrategy, Component, computed, input, signal} from '@angular/core';

/**
 * A character's face. Not `<app-avatar>`: that resolves a user id through the profile cache, and a
 * persona has neither. The ring is the character's own colour, which is the only mark a persona
 * carries in the timeline.
 */
@Component({
    selector: 'app-persona-avatar',
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <span
            [class]="sizeClass()"
            [style.background]="tint()"
            [style.box-shadow]="ring()"
            class="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full select-none"
        >
            @if (src()) {
                <img
                    (error)="failed.set(true)"
                    [alt]="name()"
                    [src]="src()"
                    class="h-full w-full object-cover"
                />
            } @else {
                <span [style.color]="color() ?? 'var(--color-text-secondary)'" class="font-semibold">
                    {{ initial() }}
                </span>
            }
        </span>
    `,
})
export class PersonaAvatarComponent {
    readonly name = input<string>('');
    readonly avatarUrl = input<string | null>(null);
    readonly color = input<string | null>(null);
    readonly size = input<'xs' | 'sm' | 'md' | 'lg' | 'xl'>('md');
    /** Retired characters keep rendering everywhere; they just stop looking selectable. */
    readonly muted = input(false);

    protected readonly failed = signal(false);

    protected readonly src = computed(() => (this.failed() ? null : this.avatarUrl()));

    protected readonly initial = computed(() => this.name().trim().charAt(0).toUpperCase() || '?');

    protected readonly sizeClass = computed(() => {
        switch (this.size()) {
            case 'xs':
                return 'h-5 w-5 text-[0.625rem]';
            case 'sm':
                return 'h-7 w-7 text-[0.6875rem]';
            case 'lg':
                return 'h-12 w-12 text-base';
            case 'xl':
                return 'h-28 w-28 text-3xl';
            // Matches `app-avatar`'s default box, so a persona row lines up with a member row.
            default:
                return 'h-8 w-8 text-xs';
        }
    });

    protected readonly tint = computed(() => {
        const color = this.color();
        if (!color) return 'rgba(255,255,255,0.06)';
        return `color-mix(in srgb, ${color} 22%, var(--color-card))`;
    });

    /** An inset shadow, so the ring never changes the box the avatar occupies. */
    protected readonly ring = computed(() => {
        const color = this.color();
        const width = this.size() === 'xl' ? '3px' : this.size() === 'lg' ? '2px' : '1.5px';
        const alpha = this.muted() ? '28%' : '70%';
        if (!color) return `inset 0 0 0 ${width} rgba(255,255,255,0.10)`;
        return `inset 0 0 0 ${width} color-mix(in srgb, ${color} ${alpha}, transparent)`;
    });
}
