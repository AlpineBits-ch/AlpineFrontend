import {Component, computed, input} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {Activity, ACTIVITY_TYPE_ICONS} from '../../models/activity.model';

/** One line of rich presence, "Playing Counter-Strike 2", for surfaces with room for a subtitle and nothing more. */
@Component({
    selector: 'app-activity-line',
    imports: [TranslateModule],
    template: `
    @if (activity(); as a) {
      <span [class]="'flex items-center gap-1 min-w-0 ' + sizeClass()">
        @if (showIcon()) {
          <i [class]="'pi ' + icon()" [style.font-size]="glyphSize()"></i>
        }
        <span class="truncate">
          @if (a.type === 'Custom') {
            {{ a.name }}
          } @else {
            {{ 'ACTIVITY.LINE.' + a.type.toUpperCase() | translate: {name: a.name} }}
          }
        </span>
      </span>
    }
  `,
})
export class ActivityLineComponent {
    readonly activity = input<Activity | null | undefined>(null);

    /** Matches the host row's subtitle scale: `xs` is 10px, `sm` 11px, `md` text-xs. */
    readonly size = input<'xs' | 'sm' | 'md'>('sm');

    readonly showIcon = input(true);

    protected readonly icon = computed(() => {
        const type = this.activity()?.type;
        return type ? ACTIVITY_TYPE_ICONS[type] : ACTIVITY_TYPE_ICONS.Playing;
    });

    protected readonly sizeClass = computed(() => {
        switch (this.size()) {
            case 'xs':
                return 'text-[10px] text-white/45';
            case 'md':
                return 'text-xs text-white/45';
            default:
                return 'text-[11px] text-white/45';
        }
    });

    /** Must stay inline px: PrimeIcons ship a `font-size` on `.pi` that a Tailwind class does not reliably beat. */
    protected readonly glyphSize = computed(() => this.size() === 'md' ? '11px' : '9px');
}
