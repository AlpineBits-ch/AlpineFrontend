import {Pipe, PipeTransform} from '@angular/core';

/**
 * A running `mm:ss` / `h:mm:ss` counter for an activity's `startedAt`, Discord's format exactly.
 *
 * <p>Deliberately not {@link RelativeTimePipe}: that one is coarse by design ("2 hours ago", and
 * anything under a minute is "this minute"), which is right for a forum post and useless for a
 * timer someone is watching tick. This is the other half of the same idea and follows the same
 * contract — pure, with the clock passed in as the second argument
 * (`| activityElapsed: ticker.now()`) so a long-lived list stays live without the pipe reaching for
 * `Date.now()` and freezing at first render.</p>
 *
 * <p>The tick argument is <b>not</b> optional here, unlike on `relativeTime`. A frozen "0:00" is a
 * more convincing lie than a frozen date, so the type makes forgetting it a compile error.</p>
 */
@Pipe({name: 'activityElapsed'})
export class ActivityElapsedPipe implements PipeTransform {
    transform(startedAt: number | null | undefined, nowMs: number): string {
        if (startedAt == null || !Number.isFinite(startedAt)) return '';

        // Clamped at zero rather than hidden: a server stamp a second ahead of our corrected clock
        // is normal jitter, and "0:00" for that second is correct, where "-0:01" is alarming.
        const totalSeconds = Math.max(0, Math.floor((nowMs - startedAt) / 1000));

        const seconds = totalSeconds % 60;
        const minutes = Math.floor(totalSeconds / 60) % 60;
        const hours = Math.floor(totalSeconds / 3600);

        const mm = minutes.toString().padStart(2, '0');
        const ss = seconds.toString().padStart(2, '0');

        // Minutes are only zero-padded once there is an hours field in front of them, so a short
        // session reads "7:04" rather than "07:04" - again matching Discord, and matching the call
        // timer in `CallPanelComponent`.
        return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
    }
}
