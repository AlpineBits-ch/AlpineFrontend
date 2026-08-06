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
 * <p>This replaces `guild.ChoreReminder`, which was one event for one kind and lived in
 * {@link import('./chore.service').ChoreService}. Two things made that the wrong home. The server
 * now sends seven kinds through one envelope - expenses, settlements, decisions, restocks and
 * expiring stock as well as chores - so a chore service would have been notifying about the fridge.
 * And a per-module listener only exists once its module's service has been constructed: `ChoreService`
 * is injected by the chores board, so the reminder that was meant to reach somebody <i>not</i>
 * looking at the board only worked if they had opened it at least once this session. This service
 * is injected by the shell instead, so it is listening from launch.</p>
 *
 * <p>Nothing is filtered here. The server picks the recipients, defers anything landing inside the
 * guild's quiet hours, sends each thing at most once, and drops alerts about work far enough past
 * its deadline to be history rather than news. Re-deciding any of that on the client would either
 * duplicate the rules or contradict them.</p>
 */
@Injectable({providedIn: 'root'})
export class HouseholdAlertService {
    private realtime = inject(RealtimeConnectionService);
    private notifications = inject(NotificationService);

    /**
     * Every alert that got through the dedupe, for anything that wants to react rather than notify.
     *
     * <p>An alert is the one household event that means "something changed that you were not
     * looking at", which is exactly when a glance surface - the home digest, the inbox's task tab -
     * is stale and cannot know it.</p>
     */
    readonly alerts$ = new Subject<HouseholdAlert>();

    /**
     * Alerts already raised this session, keyed by kind and target.
     *
     * <p>The server's once-per-thing guarantee does not cover redelivery across a reconnect, and
     * SignalR resubscribes without telling anyone what it replayed. Unbounded on purpose: it is one
     * short key per thing that actually needed telling somebody about, and a session would have to
     * run for months to collect a meaningful number of them.</p>
     */
    private seen = new Set<string>();

    constructor() {
        // Registered exactly once, here, because `RealtimeConnectionService.on` does not
        // deduplicate - and this is a root singleton, so this constructor runs once. `on` is safe
        // before `start`.
        this.realtime.on('guild.HouseholdAlert', (d: HouseholdAlert) => this.onAlert(d));
    }

    private onAlert(payload: HouseholdAlert): void {
        if (!isHouseholdAlert(payload)) return;

        const key = householdAlertKey(payload);
        if (this.seen.has(key)) return;
        this.seen.add(key);

        this.alerts$.next(payload);

        this.notifications.createNotification({
            // Server-written, both of them, and rendered as given. This is what lets an unknown
            // kind - one added after this build - still say something true on a lock screen.
            title: payload.title,
            message: payload.body ?? '',
            sound: NotificationSound.NewMessage,
            actionTypeId: 'message',
            // The keys the household push carries, so a click has what a deep-link needs.
            extra: householdAlertExtra(payload),
        }).catch(() => undefined);
    }
}
