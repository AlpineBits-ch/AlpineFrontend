import {Injectable} from '@angular/core';
import {Notifier, PushTokenKind} from '../ports/notifier.port';

/**
 * Toasts in a browser tab.
 *
 * <p>Shows real notifications through the Notification API, and registers for no push at all. The two
 * halves are worth stating separately because they fail differently: a foreground notification works
 * as soon as the user grants permission, while push - a notification for a message that arrives while
 * the tab is closed - cannot work until the server mints a `WebPush` token kind. See
 * {@link pushToken}.</p>
 *
 * <p><b>Everything here degrades rather than throws.</b> A notification is an ambient nicety; a
 * rejected promise on this path would surface inside message handling, where the message itself
 * matters more. What must never happen quietly is the app <i>claiming</i> notifications are on while
 * nothing is being shown, which is why {@link requestPermission} reports a denial honestly and why
 * `NotificationService` latches it into a flag the UI can read.</p>
 */
@Injectable()
export class WebNotifier extends Notifier {
    private readonly handlers = new Set<(tag: string) => void>();

    /**
     * Whether the browser has refused, durably.
     *
     * <p>A `denied` permission is a **one-way door**: `Notification.requestPermission()` resolves
     * `denied` immediately, without showing the user anything, for the rest of the origin's life -
     * only the user, in browser settings, can undo it. So this is latched and checked first. Calling
     * the API again per notification would be a no-op that reads like a retry.</p>
     */
    private denied = false;

    /** So a browser that cannot show notifications at all says so once, not once per message. */
    private warnedUnavailable = false;

    async requestPermission(): Promise<boolean> {
        if (!this.available()) return false;
        if (this.denied) return false;

        const current = Notification.permission;
        if (current === 'granted') return true;
        if (current === 'denied') {
            this.denied = true;
            return false;
        }

        try {
            const result = await Notification.requestPermission();
            // Only `denied` latches. `default` means the prompt was dismissed rather than refused,
            // and a browser will show it again on a later user gesture - treating that as permanent
            // would strand a user who closed the prompt by accident.
            if (result === 'denied') this.denied = true;
            return result === 'granted';
        } catch {
            // Older Safari only supports the callback form and rejects the promise one.
            return false;
        }
    }

    async notify(n: {title: string; body: string; iconUrl?: string; tag?: string}): Promise<void> {
        if (!this.available()) return;

        // Checked again rather than trusted from the caller: permission can be revoked mid-session
        // from browser UI, and constructing a Notification without it throws in some engines.
        if (Notification.permission !== 'granted') return;

        const options: NotificationOptions = {
            body: n.body,
            icon: n.iconUrl,
            // Coalescing: a second notification with the same tag replaces the first rather than
            // stacking. The tag encodes the conversation, so a burst in one chat collapses. See
            // `notification-tag.ts`.
            tag: n.tag,
        };

        try {
            const notification = new Notification(n.title, options);
            notification.onclick = () => {
                notification.close();
                this.activate(n.tag ?? '');
            };
        } catch {
            // Some engines - Chrome on Android most prominently - make the constructor an illegal
            // one and require notifications to come from a service worker registration. Detected by
            // trying it rather than by sniffing the browser, because the set of engines that do this
            // is not stable and a UA check would be wrong the same day it shipped.
            if (await this.notifyViaServiceWorker(n.title, options)) return;
            this.warnUnavailable(
                'this browser requires a service worker to show notifications, and none is registered',
            );
        }
    }

    /**
     * Web Push, which is the transport a browser would register.
     *
     * <p>Reported even though {@link pushToken} has nothing to hand over, because the kind is what
     * makes the gap nameable: "this host would speak WebPush" is a different statement from "this
     * host takes no push", and the second is what a null kind means.</p>
     */
    pushTokenKind(): PushTokenKind {
        return 'WebPush';
    }

    /**
     * Always null: **there is no Web Push on this client yet, and it is not a client-only fix.**
     *
     * <p>Three things are missing, none of them here:</p>
     * <ol>
     *   <li><b>A service worker.</b> Push is delivered to a worker, not to a page - a closed tab has
     *       no page. There is no service worker in this build at all, and adding one is a caching and
     *       update-semantics decision beyond notifications (the design spec puts service-worker
     *       caching out of scope).</li>
     *   <li><b>VAPID keys.</b> `PushManager.subscribe` needs the server's public application key, and
     *       the subscription it returns is an endpoint URL plus two keys - not a bearer token. It has
     *       no representation in the `{token, kind}` shape the current endpoint accepts.</li>
     *   <li><b>A server that accepts a third kind.</b> The push-token endpoint takes `Fcm` and
     *       `ApnsVoip`; a `WebPush` row would need the endpoint plus `p256dh` and `auth`, and a sender
     *       that signs VAPID JWTs instead of calling FCM or APNs.</li>
     * </ol>
     *
     * <p>Returning null rather than throwing or inventing a placeholder is the point. `UserTokenService`
     * treats a null token as "nothing to register" and posts nothing, so sign-in completes and the
     * server never gets a device row with an unusable transport on it - a row that would otherwise be
     * chosen as a delivery target and silently drop every notification sent to it.</p>
     */
    async pushToken(): Promise<string | null> {
        return null;
    }

    async onActivated(handler: (tag: string) => void): Promise<() => void> {
        this.handlers.add(handler);
        return () => void this.handlers.delete(handler);
    }

    /**
     * Falls back to `ServiceWorkerRegistration.showNotification`.
     *
     * <p>Uses an existing registration and never installs one - registering a worker as a side effect
     * of showing a toast would change the app's update and caching behaviour from inside a
     * notification call. Returns false when there is nothing to use, so the caller can say so.</p>
     *
     * <p><b>Clicks on these do not come back.</b> A service-worker notification fires
     * `notificationclick` in the worker, not in this page, so {@link onActivated} handlers never run
     * for one. Closing that gap needs the worker script that item 1 of {@link pushToken} describes,
     * which would post the tag back to the page - the same plumbing Web Push needs, which is why it is
     * one piece of work and not two.</p>
     */
    private async notifyViaServiceWorker(title: string, options: NotificationOptions): Promise<boolean> {
        try {
            const container = navigator.serviceWorker;
            if (!container) return false;

            const registration = await container.getRegistration();
            if (!registration) return false;

            await registration.showNotification(title, options);
            return true;
        } catch {
            return false;
        }
    }

    /** Whether this document can show a notification at all. */
    private available(): boolean {
        if (typeof window === 'undefined' || !('Notification' in window)) {
            this.warnUnavailable('this browser has no Notification API');
            return false;
        }
        return true;
    }

    private warnUnavailable(reason: string): void {
        if (this.warnedUnavailable) return;
        this.warnedUnavailable = true;
        console.warn(`Notifications will not be shown: ${reason}.`);
    }

    /**
     * A click, routed back into the app.
     *
     * <p>`window.focus()` is the browser's counterpart to the desktop adapter's `requestUserAttention`:
     * a background tab is what the user clicked away from, and routing them to a conversation in a tab
     * they cannot see is the same bug as navigating a window that stays behind. Best-effort - popup
     * blockers may refuse it - and the activation is delivered either way.</p>
     */
    private activate(tag: string): void {
        try {
            window.focus();
        } catch {
            // Refused focus is not a reason to drop the click.
        }
        for (const handler of [...this.handlers]) handler(tag);
    }
}
