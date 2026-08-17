/**
 * `NotificationService` decides whether a notification is warranted; the {@link Notifier} adapter
 * decides how it is shown. These tests are about the seam, and above all about a user seeing
 * notifications reported as on while nothing is being shown. A fake adapter is provided in TestBed
 * rather than mocking a Tauri module, which is what lets the web-shaped cases be expressed.
 */
import {signal} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {PlatformCapabilities, tauriCapabilities, webCapabilities} from '../platform/capabilities';
import {Notifier} from '../platform/ports/notifier.port';
import {decodeNotificationTag} from '../platform/notification-tag';
import {FakeNotifier} from '../platform/testing/fake-notifier';
import {NotificationService, NotificationSound} from './notification.service';
import {SoundSettingsService} from './sound-settings.service';
import {UserSettingsService} from './user-settings.service';

interface NotificationSettings {
    enabled: boolean;
    dm: boolean;
    mentions: boolean;
    sounds: boolean;
    cooldownEnabled: boolean;
    cooldownSeconds: number;
}

const ALL_ON: NotificationSettings = {
    enabled: true,
    dm: true,
    mentions: true,
    sounds: true,
    cooldownEnabled: false,
    cooldownSeconds: 30,
};

function setup(options?: {
    host?: 'tauri' | 'web';
    settings?: Partial<NotificationSettings>;
    configure?: (notifier: FakeNotifier) => void;
}) {
    const notifier = new FakeNotifier();
    options?.configure?.(notifier);

    const notificationSettings = signal<NotificationSettings>({...ALL_ON, ...options?.settings});
    const playMessage = vi.fn();
    const capabilities = options?.host === 'web' ? webCapabilities() : tauriCapabilities();

    TestBed.configureTestingModule({
        providers: [
            {provide: Notifier, useValue: notifier},
            {provide: PlatformCapabilities, useValue: capabilities},
            {provide: UserSettingsService, useValue: {notificationSettings}},
            {provide: SoundSettingsService, useValue: {playMessage}},
        ],
    });

    return {
        service: TestBed.inject(NotificationService),
        notifier,
        notificationSettings,
        playMessage,
    };
}

it('hands the notification to the port with the routing payload on its tag', async () => {
    const {service, notifier} = setup();

    await service.createNotification({
        title: 'Ada',
        message: 'ping',
        sound: NotificationSound.NewMessage,
        category: 'dm',
        extra: {conversationId: 'conv-1', type: 'dm'},
        profile: {avatarUrl: 'https://cdn/avatar.png'} as never,
    });

    expect(notifier.notifications).toHaveLength(1);
    const [sent] = notifier.notifications;
    expect(sent.title).toBe('Ada');
    expect(sent.body).toBe('ping');
    expect(sent.iconUrl).toBe('https://cdn/avatar.png');
    // The tag is the only thing an activation carries back, so the routing payload has to survive it.
    expect(decodeNotificationTag(sent.tag)).toEqual({
        actionTypeId: 'message',
        extra: {conversationId: 'conv-1', type: 'dm'},
    });
});

it('routes an activation back onto action$ with its extra intact', async () => {
    const {service, notifier} = setup();
    const seen: {actionTypeId: string; extra: Record<string, string>}[] = [];
    service.action$.subscribe(event => seen.push(event));

    await service.createNotification({
        title: 'Ada',
        message: 'ping',
        sound: NotificationSound.None,
        actionTypeId: 'household',
        extra: {type: 'household', choreId: 'chore-9'},
    });
    notifier.activate(notifier.notifications[0].tag!);

    // `main-page.component.ts` navigates on exactly these two fields.
    expect(seen).toEqual([{actionTypeId: 'household', extra: {type: 'household', choreId: 'chore-9'}}]);
});

it('applies the category filters before touching the port', async () => {
    const {service, notifier} = setup({settings: {dm: false}});

    await service.createNotification({
        title: 'Ada',
        message: 'ping',
        sound: NotificationSound.None,
        category: 'dm',
    });

    expect(notifier.notifications).toHaveLength(0);
    expect(notifier.permissionRequests).toBe(0);
});

it('plays the sound during cooldown but suppresses the toast', async () => {
    const {service, notifier, playMessage} = setup({
        settings: {cooldownEnabled: true, cooldownSeconds: 60},
    });

    await service.createNotification({title: 'a', message: '1', sound: NotificationSound.NewMessage});
    await service.createNotification({title: 'b', message: '2', sound: NotificationSound.NewMessage});

    expect(playMessage).toHaveBeenCalledTimes(2);
    expect(notifier.notifications).toHaveLength(1);
});

it('still shows notifications when the host reports no activations', async () => {
    // A host that cannot report clicks is a routing loss, not a notification loss: rethrowing would
    // leave `initPromise` rejected and take every later notification down with it.
    const {service, notifier} = setup({
        configure: n => {
            n.activationError = new Error('no listener here');
        },
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await service.createNotification({title: 'a', message: '1', sound: NotificationSound.None});

    expect(notifier.notifications).toHaveLength(1);
});

// ---------------------------------------------------------------------------
// A refused permission
// ---------------------------------------------------------------------------

/**
 * The failure that matters: `notificationSettings().enabled` is intent and stays true, while
 * whether the host will show anything is a separate fact. `notificationsBlocked` reconciles the
 * two, and is latched only where a refusal is durable.
 */
describe('when permission is refused', () => {
    it('shows nothing', async () => {
        const {service, notifier} = setup({
            host: 'web',
            configure: n => {
                n.permissionGranted = false;
            },
        });

        await service.createNotification({title: 'a', message: '1', sound: NotificationSound.None});

        expect(notifier.notifications).toHaveLength(0);
    });

    it('reports itself blocked on a host that will not re-prompt, and stops asking', async () => {
        const {service, notifier} = setup({
            host: 'web',
            configure: n => {
                n.permissionGranted = false;
            },
        });
        expect(service.notificationsBlocked()).toBe(false);

        await service.createNotification({title: 'a', message: '1', sound: NotificationSound.None});
        await service.createNotification({title: 'b', message: '2', sound: NotificationSound.None});
        await service.createNotification({title: 'c', message: '3', sound: NotificationSound.None});

        // A browser resolves `denied` without showing anything, forever, so asking per message is a
        // no-op that hides the state instead of surfacing it.
        expect(notifier.permissionRequests).toBe(1);
        expect(service.notificationsBlocked()).toBe(true);
    });

    it('keeps asking on a native host, where a refusal is not final', async () => {
        // A desktop refusal must be re-checked: the user can grant in OS settings without the app
        // hearing, and latching would disable notifications for the session after one "not now".
        const {service, notifier} = setup({
            configure: n => {
                n.permissionGranted = false;
            },
        });

        await service.createNotification({title: 'a', message: '1', sound: NotificationSound.None});
        await service.createNotification({title: 'b', message: '2', sound: NotificationSound.None});

        expect(notifier.permissionRequests).toBe(2);
        expect(service.notificationsBlocked()).toBe(false);
    });

    it('shows notifications again once permission is granted on a native host', async () => {
        const {service, notifier} = setup({
            configure: n => {
                n.permissionGranted = false;
            },
        });

        await service.createNotification({title: 'a', message: '1', sound: NotificationSound.None});
        notifier.permissionGranted = true;
        await service.createNotification({title: 'b', message: '2', sound: NotificationSound.None});

        expect(notifier.notifications.map(n => n.title)).toEqual(['b']);
    });

    it('still plays the sound, because that needs no host permission', async () => {
        // Sound is the app's own audio element, so a denied toast must not silence it too.
        const {service, playMessage} = setup({
            host: 'web',
            configure: n => {
                n.permissionGranted = false;
            },
        });

        await service.createNotification({title: 'a', message: '1', sound: NotificationSound.NewMessage});

        expect(playMessage).toHaveBeenCalledTimes(1);
    });
});
