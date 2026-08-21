import {inject, Injectable} from '@angular/core';
import {Subject} from 'rxjs';
import {
    HouseholdAlert,
    householdAlertExtra,
    householdAlertKey,
    isHouseholdAlert,
} from '../dtos/response/household-alert.dto';
import {NotificationService, NotificationSound} from './notification.service';
import {RealtimeConnectionService} from './realtime-connection.service';

/**
 * The single listener for `guild.HouseholdAlert`, and the only place a household event becomes an
 * OS notification.
 *
 * Must stay on the {@link REALTIME_LISTENER} list: a listener owned by a feature service only
 * exists once that feature has been opened. Nothing is filtered here, the server owns recipients
 * and quiet hours.
 */
@Injectable({providedIn: 'root'})
export class HouseholdAlertService {
    private realtime = inject(RealtimeConnectionService);
    private notifications = inject(NotificationService);

    /** Every alert that got through the dedupe, for anything that wants to react rather than notify. */
    readonly alerts$ = new Subject<HouseholdAlert>();

    /** Alerts already raised this session: the server's once-per-thing guarantee does not cover redelivery across a reconnect. */
    private seen = new Set<string>();

    constructor() {
        // Registered exactly once, here: `on` does not deduplicate, and this is a root singleton.
        this.realtime.on('guild.HouseholdAlert', (d: HouseholdAlert) => this.onAlert(d));
    }

    private onAlert(payload: HouseholdAlert): void {
        if (!isHouseholdAlert(payload)) return;

        const key = householdAlertKey(payload);
        if (this.seen.has(key)) return;
        this.seen.add(key);

        this.alerts$.next(payload);

        this.notifications
            .createNotification({
                // Server-written, both of them, and rendered as given, so a kind added after this build
                // still says something true on a lock screen.
                title: payload.title,
                message: payload.body ?? '',
                sound: NotificationSound.NewMessage,
                actionTypeId: 'message',
                // The keys the household push carries, so a click has what a deep-link needs.
                extra: householdAlertExtra(payload),
            })
            .catch(() => undefined);
    }
}
