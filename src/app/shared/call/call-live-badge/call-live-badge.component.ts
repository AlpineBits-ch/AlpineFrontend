import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';

/**
 * The LIVE marker on anything that is broadcasting.
 *
 * <p>There were four of these: `bg-red-500 px-1.5` on a participant tile, `bg-red-500 px-2` on a
 * share tile, a tinted `bg-red-500/15` pill in the channel-list row, and a translated
 * `bg-online/15` pill with a ping animation on the channel item - so the same fact was emerald in
 * one pane and one of two different reds in the others, and only one of the four was translated.</p>
 */
@Component({
    selector: 'app-call-live-badge',
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [TranslateModule],
    template: `
        <span [class]="shellClass()">
            @if (dot()) {
                <span class="size-1.5 shrink-0 rounded-full bg-current status-pulse"></span>
            }
            {{ 'CALL.LIVE' | translate }}
        </span>
    `,
    styles: `:host { display: inline-flex; }`,
})
export class CallLiveBadgeComponent {
    /** `solid` sits on video and has to win against it; `soft` sits on a surface beside text. */
    variant = input<'solid' | 'soft'>('solid');
    size = input<'sm' | 'md'>('md');
    /** A pulsing dot, for the places where the badge is the only thing saying "right now". */
    dot = input(false);

    protected readonly shellClass = computed(() => {
        const base = 'inline-flex items-center gap-1 rounded font-bold uppercase leading-none tracking-widest '
            + (this.size() === 'sm'
                ? 'px-1 py-0.5 text-[0.5625rem]'
                : 'px-1.5 py-0.5 text-[0.6875rem]');

        return this.variant() === 'solid'
            ? `${base} bg-live text-white`
            : `${base} bg-live/15 text-live`;
    });
}
