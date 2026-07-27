import {Component, computed, input} from '@angular/core';
import {NgClass} from '@angular/common';
import {OnlineStatus} from '../../dtos/response/profile.dto';

const SIZE_CLASSES: Record<'sm' | 'md' | 'lg', string> = {
    sm: 'w-2.5 h-2.5',
    md: 'w-3 h-3',
    lg: 'w-3.5 h-3.5',
};

/**
 * Avatar overlay dot indicating a user's online status.
 * Place inside a `relative`-positioned container; renders nothing when status is null (group chats).
 */
@Component({
    selector: 'app-user-status-dot',
    imports: [NgClass],
    template: `
    @if (status() !== null) {
      <div class="absolute -bottom-0.5 -right-0.5 rounded-full border-2"
           [ngClass]="classes()">
      </div>
    }
  `,
})
export class UserStatusDotComponent {
    status = input.required<OnlineStatus | null>();
    size = input<'sm' | 'md' | 'lg'>('sm');
    borderColor = input<string>('border-sidebar');

    protected classes = computed(() => [
        SIZE_CLASSES[this.size()],
        this.borderColor(),
        this.colorClass(),
    ]);

    private colorClass(): string {
        switch (this.status()) {
            case OnlineStatus.Online: return 'bg-emerald-400';
            case OnlineStatus.Idle: return 'bg-amber-400';
            case OnlineStatus.DoNotDisturb: return 'bg-rose-500';
            default: return 'bg-white/20';
        }
    }
}
