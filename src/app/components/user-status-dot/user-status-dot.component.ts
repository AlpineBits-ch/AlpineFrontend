import {Component, computed, input} from '@angular/core';
import {OnlineStatus} from '../../dtos/response/profile.dto';

const SIZE_CLASSES: Record<'sm' | 'md' | 'lg', string> = {
    sm: 'w-2.5 h-2.5',
    md: 'w-3 h-3',
    lg: 'w-3.5 h-3.5',
};

/**
 * The opaque backing behind each silhouette, keyed by the ring colour the caller already passes.
 *
 * <p>Every non-online status is drawn by punching a hole in the dot, and a hole shows whatever is
 * behind it — which, for an avatar badge, is a face. So the dot needs a backing in the colour of
 * the surface it sits on, and the caller has already told us that: `borderColor` is the ring that
 * separates the dot from the same surface. Deriving one from the other keeps the component's
 * interface at one input instead of two that must agree.</p>
 */
const SURFACE_BACKING: Record<string, string> = {
    'border-sidebar': 'bg-sidebar',
    'border-card': 'bg-card',
    'border-app-bg': 'bg-app-bg',
    'border-hover': 'bg-hover',
};

/**
 * Status dot indicating a user's online status.
 * By default an avatar corner-overlay badge -place inside a `relative`-positioned
 * container larger than the dot itself (e.g. an avatar). Set `standalone` to render
 * as a plain centered dot instead (e.g. inside a same-sized wrapper). Renders nothing
 * when status is null (group chats).
 *
 * <p><b>Two nested elements, deliberately.</b> The outer one positions the dot and carries the
 * surface colour; the inner one carries the status colour and the silhouette mask. Flattening them
 * would leave the idle crescent's bite transparent, showing the avatar through the notch. The masks
 * themselves live in `styles.css` as `.status-shape-*`.</p>
 */
@Component({
    selector: 'app-user-status-dot',
    template: `
    @if (status() !== null) {
      <div [class]="outerClasses()">
        <div [class]="innerClasses()"></div>
      </div>
    }
  `,
})
export class UserStatusDotComponent {
    status = input.required<OnlineStatus | null>();
    size = input<'sm' | 'md' | 'lg'>('sm');
    borderColor = input<string>('border-sidebar');
    standalone = input<boolean>(false);

    protected outerClasses = computed(() => {
        const backing = SURFACE_BACKING[this.borderColor()] ?? 'bg-sidebar';
        if (this.standalone()) {
            return ['rounded-full', SIZE_CLASSES[this.size()], backing].join(' ');
        }
        return [
            'absolute', '-bottom-0.5', '-right-0.5', 'rounded-full', 'border-2',
            SIZE_CLASSES[this.size()], this.borderColor(), backing,
        ].join(' ');
    });

    protected innerClasses = computed(() =>
        ['w-full', 'h-full', 'rounded-full', ...this.statusClasses()].join(' ')
    );

    /**
     * Colour plus silhouette.
     *
     * <p>Online is the only status with no mask — it is the plain disc every other shape is cut
     * from, so giving it one would cost a paint for nothing.</p>
     */
    private statusClasses(): string[] {
        switch (this.status()) {
            case OnlineStatus.Online:
                return ['bg-online'];
            case OnlineStatus.Idle:
                return ['bg-connecting', 'status-shape-idle'];
            case OnlineStatus.DoNotDisturb:
                return ['bg-offline', 'status-shape-dnd'];
            default:
                return ['bg-text-muted', 'status-shape-invisible'];
        }
    }
}
