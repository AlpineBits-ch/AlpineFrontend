import {ChangeDetectionStrategy, Component, computed, input} from '@angular/core';
import {OnlineStatus} from '../../dtos/response/profile.dto';

const SIZE_CLASSES: Record<'sm' | 'md' | 'lg', string> = {
    sm: 'w-2.5 h-2.5',
    md: 'w-3 h-3',
    lg: 'w-3.5 h-3.5',
};

/** The opaque backing behind each silhouette, keyed by the ring colour the caller already passes. */
const SURFACE_BACKING: Record<string, string> = {
    'border-sidebar': 'bg-sidebar',
    'border-card': 'bg-card',
    'border-app-bg': 'bg-app-bg',
    'border-hover': 'bg-hover',
};

/**
 * Status dot indicating a user's online status. By default an avatar corner-overlay badge: place it inside a
 * `relative`-positioned container. Set `standalone` for a plain centered dot. Renders nothing when status is null.
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
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UserStatusDotComponent {
    readonly status = input.required<OnlineStatus | null>();
    readonly size = input<'sm' | 'md' | 'lg'>('sm');
    readonly borderColor = input<string>('border-sidebar');
    readonly standalone = input<boolean>(false);

    protected readonly outerClasses = computed(() => {
        const backing = SURFACE_BACKING[this.borderColor()] ?? 'bg-sidebar';
        if (this.standalone()) {
            return ['rounded-full', SIZE_CLASSES[this.size()], backing].join(' ');
        }
        return [
            'absolute',
            '-bottom-0.5',
            '-right-0.5',
            'rounded-full',
            'border-2',
            SIZE_CLASSES[this.size()],
            this.borderColor(),
            backing,
        ].join(' ');
    });

    protected readonly innerClasses = computed(() =>
        ['w-full', 'h-full', 'rounded-full', ...this.statusClasses()].join(' '),
    );

    /** Colour plus silhouette. Online is the only status with no mask. */
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
