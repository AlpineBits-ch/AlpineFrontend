import {Pipe, PipeTransform} from '@angular/core';

/**
 * A running `mm:ss` / `h:mm:ss` counter for an activity's `startedAt`. Pure, with the clock passed
 * in (`| activityElapsed: ticker.now()`); the tick argument is required, not optional.
 */
@Pipe({name: 'activityElapsed'})
export class ActivityElapsedPipe implements PipeTransform {
    transform(startedAt: number | null | undefined, nowMs: number): string {
        if (startedAt == null || !Number.isFinite(startedAt)) return '';

        // Clamped at zero: a server stamp a second ahead of our corrected clock is normal jitter.
        const totalSeconds = Math.max(0, Math.floor((nowMs - startedAt) / 1000));

        const seconds = totalSeconds % 60;
        const minutes = Math.floor(totalSeconds / 60) % 60;
        const hours = Math.floor(totalSeconds / 3600);

        const mm = minutes.toString().padStart(2, '0');
        const ss = seconds.toString().padStart(2, '0');

        // Minutes are zero-padded only when an hours field precedes them: "7:04", not "07:04".
        return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
    }
}
