import {inject, Pipe, PipeTransform} from '@angular/core';
import {TranslateService} from '@ngx-translate/core';

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
];

/**
 * Coarse "2 hours ago" phrasing, localised off the active language.
 *
 * Pure, so it only recomputes when its inputs change. `Date.now()` isn't an input,
 * which would leave a long-lived list frozen at the timestamps it first rendered -
 * pass a ticking signal as the second argument (`| relativeTime: now()`) wherever the
 * text needs to stay live.
 */
@Pipe({name: 'relativeTime'})
export class RelativeTimePipe implements PipeTransform {
    private translate = inject(TranslateService);

    transform(value: string | Date | null | undefined, _tick?: number): string {
        if (!value) return '';

        const then = value instanceof Date ? value.getTime() : new Date(value).getTime();
        if (Number.isNaN(then)) return '';

        const seconds = Math.round((then - Date.now()) / 1000);
        const fmt = new Intl.RelativeTimeFormat(this.translate.currentLang || 'en', {numeric: 'auto'});

        for (const [unit, size] of UNITS) {
            if (Math.abs(seconds) >= size) return fmt.format(Math.round(seconds / size), unit);
        }
        return fmt.format(0, 'minute');
    }
}
