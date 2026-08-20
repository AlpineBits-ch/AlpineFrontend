import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';

/** Anything with a name and a colour: a forum tag, a scene tag. */
export interface ChipTag {
    name: string;
    color: string;
    /** A guild custom emoji id. Mutually exclusive with emojiName. */
    emojiId?: string | null;
    /** A unicode emoji. Mutually exclusive with emojiId. */
    emojiName?: string | null;
}

/** One tag pill: takes its interactive state from inputs, used in filter bars, on cards, and in pickers. A tag colour of #000000 is the server's "no colour chosen" default, not real black; those render in the neutral surface style instead of an unreadable black pill. */
@Component({
    selector: 'app-tag-chip',
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <span
            [class.cursor-pointer]="interactive()"
            [style.background]="background()"
            [style.border-color]="borderColor()"
            [style.color]="textColor()"
            class="inline-flex items-center gap-1.5 rounded-full border font-medium leading-none transition-colors select-none whitespace-nowrap"
            [class]="sizeClasses()"
        >
            @if (emojiUrl(); as url) {
                <img [src]="url" alt="" class="w-3.5 h-3.5 object-contain shrink-0" />
            } @else if (tag().emojiName) {
                <span class="shrink-0">{{ tag().emojiName }}</span>
            }
            <span class="truncate max-w-[10rem]">{{ tag().name }}</span>
            @if (count() !== null) {
                <span class="opacity-50 tabular-nums">{{ count() }}</span>
            }
            @if (removable()) {
                <i class="pi pi-times text-[0.5rem] opacity-60 hover:opacity-100"></i>
            }
        </span>
    `,
})
export class TagChipComponent {
    readonly tag = input.required<ChipTag>();
    /** Renders in the filled/active treatment: used for filter bar selection and picker state. */
    readonly selected = input(false);
    readonly interactive = input(false);
    readonly removable = input(false);
    readonly size = input<'sm' | 'xs'>('sm');
    /** Resolved guild-emoji image, when the tag points at one. Absent renders no image. */
    readonly emojiUrl = input<string | null>(null);
    /** A number shows the count badge; null hides it. */
    readonly count = input<number | null>(null);

    protected readonly sizeClasses = computed(() =>
        this.size() === 'xs' ? 'text-[0.625rem] px-1.5 py-[0.1875rem]' : 'text-[0.6875rem] px-2 py-1',
    );

    /** Falsy or the server's #000000 default both mean "no colour". */
    private readonly hasColor = computed(() => {
        const c = this.tag().color;
        return !!c && c.toLowerCase() !== '#000000';
    });

    protected readonly background = computed(() => {
        if (!this.hasColor()) {
            return this.selected() ? 'var(--color-hover)' : 'transparent';
        }
        const pct = this.selected() ? '28%' : '12%';
        return `color-mix(in srgb, ${this.tag().color} ${pct}, transparent)`;
    });

    protected readonly borderColor = computed(() => {
        if (!this.hasColor()) {
            return this.selected() ? 'var(--color-border-default)' : 'var(--color-border-subtle)';
        }
        const pct = this.selected() ? '60%' : '30%';
        return `color-mix(in srgb, ${this.tag().color} ${pct}, transparent)`;
    });

    protected readonly textColor = computed(() => {
        if (!this.hasColor()) {
            return this.selected() ? 'var(--color-text-primary)' : 'var(--color-text-secondary)';
        }
        // Lift the raw tag colour toward white so a dark user-picked colour stays legible on the dark surface; selected pills lift further to read as "on".
        return `color-mix(in srgb, ${this.tag().color} ${this.selected() ? '55%' : '70%'}, #ffffff)`;
    });
}
