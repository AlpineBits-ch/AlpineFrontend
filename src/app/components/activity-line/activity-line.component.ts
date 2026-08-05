import {Component, computed, input} from '@angular/core';
import {TranslateModule} from '@ngx-translate/core';
import {Activity, ACTIVITY_TYPE_ICONS} from '../../models/activity.model';

/**
 * One line of rich presence — "Playing Counter-Strike 2" — for the surfaces that have room for a
 * subtitle and nothing more: the member row, a DM row, the friends list, the self panel.
 *
 * <p>No timer here. Discord does not put one in the member list either, and it is the right call
 * twice over: a second-resolution counter on 200 rows is the exact thing
 * {@link ActivityTickerService} exists to avoid, and the line is a label, not a stopwatch. The
 * elapsed time lives in {@link ActivityCardComponent}, one instance at a time.</p>
 *
 * <p>The verb and the name go through one interpolated translation rather than being concatenated
 * in the template, because "Playing X" is not word order every language shares.</p>
 */
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
    activity = input<Activity | null | undefined>(null);

    /**
     * Matches the host row's own subtitle scale rather than imposing one. The three values are the
     * three sizes already in use for a second line: `xs` is the activity feed's `text-[10px]`, `sm`
     * the member list's `text-[11px]`, `md` the friends list's `text-xs`.
     */
    size = input<'xs' | 'sm' | 'md'>('sm');

    showIcon = input(true);

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

    /**
     * The glyph is set in px rather than with a text size utility because PrimeIcons ship their own
     * `font-size` on `.pi`, which a Tailwind class of equal specificity does not reliably beat -
     * the same reason the sound-preview and activity-feed buttons set it inline.
     */
    protected readonly glyphSize = computed(() => this.size() === 'md' ? '11px' : '9px');
}
