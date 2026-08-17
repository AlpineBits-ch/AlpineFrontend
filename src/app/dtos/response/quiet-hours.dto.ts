/**
 * The household's "don't ping the flat at 03:00" window.
 *
 * <p>It is not a mute: chore reminders that would have fired inside the window are **deferred to
 * its end**, not dropped. Nothing else is suppressed.</p>
 *
 * <p>Minutes past local midnight rather than a time string, and an IANA zone rather than an
 * offset - the window is anchored to the flat's wall clock, so it moves with DST.</p>
 */
export interface QuietHoursDto {
    enabled: boolean;
    /** 0-1439. */
    startMinuteLocal: number;
    /** 0-1439. **Wraps midnight when `start > end`** - 22:00 → 07:00 is the ordinary case. */
    endMinuteLocal: number;
    /** IANA, e.g. `"Europe/Zurich"`. */
    timeZoneId: string;
}
