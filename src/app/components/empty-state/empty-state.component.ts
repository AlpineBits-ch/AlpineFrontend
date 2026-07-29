import {Component, computed, input} from '@angular/core';

/**
 * Shared icon+caption empty-state idiom used across friends/DM/activity panels,
 * so every "nothing here yet" screen stays visually identical at a given size.
 * `sm` fits compact sidebar contexts (activity feed, DM list); `lg` fits a full
 * page content area (friends/home tabs).
 */
@Component({
    selector: 'app-empty-state',
    template: `
    <div class="flex flex-col items-center justify-center gap-2 text-center px-3" [class]="containerClass()">
      @if (size() === 'sm') {
        <div class="w-8 h-8 rounded-full bg-white/[0.04] flex items-center justify-center">
          <i class="pi text-white/20 text-sm" [class]="icon()"></i>
        </div>
      } @else {
        <svg width="120" height="64" viewBox="0 0 120 64" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M4 56 L28 22 L42 40 L58 12 L78 44 L92 26 L116 56"
                stroke="var(--color-brand-dim)" stroke-width="3"
                stroke-linejoin="round" stroke-linecap="round" opacity="0.55"/>
          <circle cx="58" cy="12" r="3.5" fill="var(--color-brand-dim)" opacity="0.8"/>
        </svg>
      }
      <p [class]="size() === 'sm' ? 'text-[11px] text-white/25' : 'text-sm text-white/25'" class="leading-snug">
        {{ message() }}
      </p>
    </div>
  `,
})
export class EmptyStateComponent {
    icon = input.required<string>();
    message = input.required<string>();
    size = input<'sm' | 'lg'>('sm');

    protected containerClass = computed(() => this.size() === 'sm' ? 'py-10' : 'h-40');
}
