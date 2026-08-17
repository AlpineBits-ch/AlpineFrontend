import {Injectable} from '@angular/core';
import {Notifier, PushTokenKind} from '../ports/notifier.port';
import {decodeNotificationTag, encodeNotificationTag, NotificationTagPayload} from '../notification-tag';

/** The one action type the app registers, and the default every activation falls back to. */
const MESSAGE_ACTION_TYPE = 'message';

/**
 * Toasts and push registration inside the desktop shell.
 *
 * <p>Holds the whole of what `NotificationService` used to know about hosts: that Windows does not go
 * through the notification plugin at all, that macOS needs the avatar copied to a local file first,
 * and that Linux's `notify-rust` backend accepts no action types. None of that is a policy decision -
 * it is three backends behaving differently - which is exactly what belongs on this side of a port.</p>
 *
 * <p><b>Windows takes a separate path end to end.</b> Sending goes through the `send_windows_toast`
 * command (WinRT toasts, so they survive Focus Assist and carry an image), and activation comes back
 * as a `notification-action` Tauri event emitted from Rust rather than through the plugin's
 * `onAction`. Because that path never touches the plugin, it has no plugin permission to grant, so
 * {@link requestPermission} answers `true` there without prompting - a prompt whose answer nothing
 * reads is worse than no prompt.</p>
 *
 * <p>Every plugin is behind `import()`. The web build still bundles this file (the provider picks
 * between adapters at runtime, so both class references are static) but never constructs it, and so
 * never fetches a Tauri chunk.</p>
 */
@Injectable()
export class TauriNotifier extends Notifier {
    private readonly handlers = new Set<(tag: string) => void>();

    /** `platform()`: which toast backend to use. Null until {@link warm} resolves. */
    private platformName: string | null = null;

    /** `type()`: which push transport to register. Null until {@link warm} resolves. */
    private osTypeName: string | null = null;

    /**
     * Reading the OS, once.
     *
     * <p>This is the adapter's own read of `plugin-os`, deliberately not the `OsInfo` port: the only
     * thing here that needs the OS is which of these three notification backends is present, and
     * taking a second port for it would couple push registration to a provider it has no other reason
     * to wait on.</p>
     *
     * <p>Started at construction rather than on first call, because {@link pushTokenKind} is the one
     * synchronous member of the port and cannot await anything. Every async member awaits this first,
     * so a caller that has been handed a token has necessarily also got the platform - see the note
     * on {@link pushTokenKind}.</p>
     */
    private readonly warm: Promise<void>;

    /** The host subscription, made once however many handlers register. */
    private listening: Promise<void> | null = null;

    constructor() {
        super();
        this.warm = this.readOs();
    }

    async requestPermission(): Promise<boolean> {
        await this.warm;

        // The WinRT path has no plugin permission to grant. See the class note.
        if (this.platformName === 'windows') return true;

        const {isPermissionGranted, requestPermission} =
            await import('@choochmeque/tauri-plugin-notifications-api');
        if (await isPermissionGranted()) return true;
        return (await requestPermission()) === 'granted';
    }

    async notify(n: {title: string; body: string; iconUrl?: string; tag?: string}): Promise<void> {
        await this.warm;
        const {actionTypeId, extra} = decodeNotificationTag(n.tag);

        if (this.platformName === 'windows') {
            const {invoke} = await import('@tauri-apps/api/core');
            await invoke('send_windows_toast', {
                title: n.title,
                body: n.body,
                iconUrl: n.iconUrl ?? null,
                // Flattened into `extra` because that is the whole of what the WinRT toast carries
                // and hands back; the event listener below unflattens it.
                extra: {...extra, actionTypeId},
            });
            return;
        }

        // The macOS backend (UNUserNotificationCenter) only renders an icon from a local file:// URI,
        // so a remote avatar is downloaded to temp first. Failure keeps the remote URL rather than
        // dropping the notification: a toast with no image still says what happened.
        let icon: string | undefined = n.iconUrl;
        if (this.platformName === 'macos' && icon) {
            const {invoke} = await import('@tauri-apps/api/core');
            const local = await invoke<string | null>('prepare_notification_icon', {url: icon}).catch(
                () => null,
            );
            icon = local ?? icon;
        }

        const {sendNotification} = await import('@choochmeque/tauri-plugin-notifications-api');
        await sendNotification({
            title: n.title,
            body: n.body,
            icon,
            // The app plays its own sound, gated on the user's sound settings, before it ever gets
            // here. A backend chime on top of that would double up and ignore the setting.
            silent: true,
            actionTypeId,
            extra,
        });
    }

    /**
     * iOS registers the PushKit token CallKit rings from; every other desktop and Android host uses
     * Firebase. Unchanged from what `UserTokenService` decided before the port existed.
     *
     * <p>Returns null only before {@link warm} has resolved, which callers cannot observe in practice:
     * the only caller asks after awaiting {@link pushToken}, and that awaits the same promise. Null
     * rather than a guessed `Fcm`, because guessing here would register an iPhone under a transport
     * that cannot ring it - a failure that shows up as silent missed calls, not as an error.</p>
     */
    pushTokenKind(): PushTokenKind | null {
        if (this.osTypeName === null) return null;
        return this.osTypeName === 'ios' ? 'ApnsVoip' : 'Fcm';
    }

    /**
     * Mints a transport token. Rejects on hosts with no push backend - desktop Windows, macOS and
     * Linux all do - which is why the caller treats a failure as "no push here" rather than as an
     * error worth surfacing.
     */
    async pushToken(): Promise<string | null> {
        await this.warm;
        const {registerForPushNotifications} = await import('@choochmeque/tauri-plugin-notifications-api');
        return await registerForPushNotifications();
    }

    async onActivated(handler: (tag: string) => void): Promise<() => void> {
        await this.warm;
        this.handlers.add(handler);

        // One host subscription for all handlers: unregistering the last handler still leaves the
        // listener attached, which is deliberate. The only consumer is a root-scoped service that
        // lives as long as the window, and a listener torn down and re-attached across a resubscribe
        // would drop the activation that arrived in between.
        this.listening ??= this.subscribe();
        await this.listening;

        return () => void this.handlers.delete(handler);
    }

    private async readOs(): Promise<void> {
        const {platform, type} = await import('@tauri-apps/plugin-os');
        this.platformName = platform();
        this.osTypeName = type();
    }

    private async subscribe(): Promise<void> {
        if (this.platformName === 'windows') {
            const {listen} = await import('@tauri-apps/api/event');
            await listen<Record<string, string>>('notification-action', event => {
                this.dispatch({
                    actionTypeId: event.payload['actionTypeId'] ?? MESSAGE_ACTION_TYPE,
                    // The whole payload, `actionTypeId` included: that is what the routing code has
                    // always been handed on Windows, and `type`/`conversationId` live alongside it.
                    extra: event.payload,
                });
            });
            return;
        }

        const {onAction, registerActionTypes} = await import('@choochmeque/tauri-plugin-notifications-api');
        try {
            await registerActionTypes([{id: MESSAGE_ACTION_TYPE, actions: [{id: 'open', title: 'Open'}]}]);
        } catch {
            // notify-rust (Linux) has no concept of action types. Swallowed rather than reported,
            // because the notification itself still shows and still routes on click where the
            // backend supports it at all.
        }

        await onAction(notification => {
            this.dispatch({
                actionTypeId: notification.actionTypeId ?? MESSAGE_ACTION_TYPE,
                extra: (notification.extra ?? {}) as Record<string, string>,
            });
        });
    }

    /**
     * Fans an activation out to the handlers, and pulls the window forward.
     *
     * <p>`requestUserAttention` lives here rather than in `NotificationService` because "clicking a
     * toast should bring the app to the front" is a window-manager behaviour with no browser
     * equivalent worth the same name - the web adapter calls `window.focus()` instead. It runs before
     * the handlers, so the navigation they trigger lands on a window that is already coming up.</p>
     */
    private dispatch(payload: NotificationTagPayload): void {
        void this.requestAttention();
        const tag = encodeNotificationTag(payload);
        for (const handler of [...this.handlers]) handler(tag);
    }

    private async requestAttention(): Promise<void> {
        try {
            const {getCurrentWindow} = await import('@tauri-apps/api/window');
            await getCurrentWindow().requestUserAttention(null);
        } catch {
            // A window that will not come forward is not a reason to drop the activation; the click
            // still routes.
        }
    }
}
