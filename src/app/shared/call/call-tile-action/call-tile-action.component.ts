import {ChangeDetectionStrategy, Component, computed, input, output} from '@angular/core';

/**
 * The small icon button that floats on a tile: picture-in-picture, fullscreen, maximise, mute
 * this person's screen audio.
 *
 * <p>Eight near-copies of the same twelve utility classes lived across the participant tile and the
 * share layout, at two different sizes with no relationship between them, and none of them had an
 * accessible name beyond `title` or any focus style at all - so a keyboard user could tab into a
 * control that is `opacity-0` until hover and get no indication whatsoever of where they were.</p>
 */
@Component({
    selector: 'app-call-tile-action',
    changeDetection: ChangeDetectionStrategy.OnPush,
    template: `
        <button
                (click)="trigger($event)"
                [attr.aria-label]="label()"
                [attr.aria-pressed]="pressed()"
                [attr.title]="label()"
                [class]="buttonClass()"
                type="button">
            <i [class]="'pi ' + icon() + ' ' + iconSize()"></i>
        </button>
    `,
    styles: `:host { display: inline-flex; }`,
})
export class CallTileActionComponent {
    /** PrimeIcons class, e.g. `pi-external-link`. */
    readonly icon = input.required<string>();
    /** Already-translated. Used for both the tooltip and the accessible name. */
    readonly label = input.required<string>();
    readonly size = input<'sm' | 'md'>('md');
    /** Set only for toggles, so a plain action is not announced as a pressable state. */
    readonly pressed = input<boolean | null>(null);
    /** Danger tint, for the "this is currently muted" half of an audio toggle. */
    readonly tone = input<'neutral' | 'danger'>('neutral');

    action = output<MouseEvent>();

    protected readonly buttonClass = computed(() => {
        const box = this.size() === 'sm' ? 'w-7 h-7' : 'w-8 h-8';
        const tint = this.tone() === 'danger' ? 'text-offline' : 'text-white/75 hover:text-white';
        return `call-focusable ${box} ${tint} flex items-center justify-center rounded-lg border border-white/10`
            + ' bg-black/45 hover:bg-black/70 transition-colors cursor-pointer';
    });

    protected readonly iconSize = computed(() => this.size() === 'sm' ? 'text-xs' : 'text-sm');

    protected trigger(event: MouseEvent): void {
        // Tiles carry their own click and contextmenu handlers; a button on top of one is not a
        // click on the tile beneath it.
        event.stopPropagation();
        this.action.emit(event);
    }
}
