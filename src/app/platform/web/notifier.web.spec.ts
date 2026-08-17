/**
 * The browser {@link Notifier}.
 *
 * <p>Two things are worth testing here and the happy path is neither of them. The first is a **denied
 * permission**, which in a browser is a one-way door - the app can never re-prompt - so it has to be
 * reported honestly rather than retried, or the app ends up claiming notifications are on while
 * showing none. The second is a **null push token**, which is what this host has instead of Web Push
 * and which must be safe to hand to `UserTokenService`.</p>
 *
 * <p>jsdom implements no Notification API, so one is installed per test. That is not a shortcut: the
 * cases that matter are precisely the ones where the API is absent, refuses, or refuses to be
 * constructed, and each of those is a different stand-in.</p>
 */
import {WebNotifier} from './notifier.web';

class FakeNotification {
    static permission: NotificationPermission = 'granted';
    static requestPermission = vi.fn(
        async (): Promise<NotificationPermission> => FakeNotification.permission,
    );
    static constructed: FakeNotification[] = [];

    onclick: (() => void) | null = null;
    readonly close = vi.fn();

    constructor(
        readonly title: string,
        readonly options?: NotificationOptions,
    ) {
        FakeNotification.constructed.push(this);
    }
}

/** A browser that requires a service worker: the bare constructor is an illegal one. */
class IllegalConstructorNotification {
    static permission: NotificationPermission = 'granted';
    static requestPermission = vi.fn(async (): Promise<NotificationPermission> => 'granted');

    constructor() {
        throw new TypeError('Illegal constructor');
    }
}

function installNotification(impl: unknown): void {
    Object.defineProperty(globalThis, 'Notification', {configurable: true, writable: true, value: impl});
}

function removeNotification(): void {
    delete (globalThis as Record<string, unknown>)['Notification'];
}

function installServiceWorker(registration: unknown): {showNotification: ReturnType<typeof vi.fn>} | null {
    Object.defineProperty(navigator, 'serviceWorker', {
        configurable: true,
        value: {getRegistration: async () => registration},
    });
    return registration as {showNotification: ReturnType<typeof vi.fn>} | null;
}

function removeServiceWorker(): void {
    delete (navigator as unknown as Record<string, unknown>)['serviceWorker'];
}

beforeEach(() => {
    FakeNotification.permission = 'granted';
    FakeNotification.requestPermission = vi.fn(async () => FakeNotification.permission);
    FakeNotification.constructed = [];
    installNotification(FakeNotification);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
    removeNotification();
    removeServiceWorker();
    vi.restoreAllMocks();
});

describe('permission', () => {
    it('needs no prompt when already granted', async () => {
        const notifier = new WebNotifier();

        await expect(notifier.requestPermission()).resolves.toBe(true);
        expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    });

    it('treats an existing denial as final, without asking', async () => {
        // `Notification.requestPermission()` on a denied origin resolves `denied` immediately and shows
        // the user nothing. Calling it would look like a retry and could never succeed.
        FakeNotification.permission = 'denied';
        const notifier = new WebNotifier();

        await expect(notifier.requestPermission()).resolves.toBe(false);
        expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
    });

    it('asks once when undecided, and never asks again after a refusal', async () => {
        FakeNotification.permission = 'default';
        FakeNotification.requestPermission = vi.fn(async () => 'denied' as NotificationPermission);
        const notifier = new WebNotifier();

        await expect(notifier.requestPermission()).resolves.toBe(false);
        await expect(notifier.requestPermission()).resolves.toBe(false);

        expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1);
    });

    it('asks again after a dismissed prompt, which is not a refusal', async () => {
        // `default` means the prompt was closed, not that the user said no; browsers will show it again
        // on a later gesture. Latching here would strand someone who dismissed it by accident.
        FakeNotification.permission = 'default';
        FakeNotification.requestPermission = vi.fn(async () => 'default' as NotificationPermission);
        const notifier = new WebNotifier();

        await notifier.requestPermission();
        await notifier.requestPermission();

        expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(2);
    });

    it('reports false where there is no Notification API at all', async () => {
        removeNotification();
        const notifier = new WebNotifier();

        await expect(notifier.requestPermission()).resolves.toBe(false);
    });

    it('reports false when the promise form of the prompt is unsupported', async () => {
        // Older Safari only has the callback form and rejects this one.
        FakeNotification.permission = 'default';
        FakeNotification.requestPermission = vi.fn(async () => {
            throw new TypeError('not a function');
        }) as never;
        const notifier = new WebNotifier();

        await expect(notifier.requestPermission()).resolves.toBe(false);
    });
});

describe('notify', () => {
    it('posts the notification with its body, icon and coalescing tag', async () => {
        const notifier = new WebNotifier();

        await notifier.notify({title: 'Ada', body: 'ping', iconUrl: 'https://cdn/a.png', tag: 'conv-1'});

        expect(FakeNotification.constructed).toHaveLength(1);
        const [shown] = FakeNotification.constructed;
        expect(shown.title).toBe('Ada');
        expect(shown.options).toMatchObject({body: 'ping', icon: 'https://cdn/a.png', tag: 'conv-1'});
    });

    it('shows nothing without permission', async () => {
        // Re-checked here rather than trusted from the caller: permission can be revoked from browser
        // UI mid-session, and constructing without it throws in some engines.
        FakeNotification.permission = 'denied';
        const notifier = new WebNotifier();

        await notifier.notify({title: 'Ada', body: 'ping'});

        expect(FakeNotification.constructed).toHaveLength(0);
    });

    it('does not throw where the API is missing entirely', async () => {
        // A rejection here would surface inside message handling, where the message matters more.
        removeNotification();
        const notifier = new WebNotifier();

        await expect(notifier.notify({title: 'Ada', body: 'ping'})).resolves.toBeUndefined();
    });

    it('falls back to a service worker registration when the constructor is illegal', async () => {
        const showNotification = vi.fn(async () => undefined);
        installServiceWorker({showNotification});
        installNotification(IllegalConstructorNotification);
        const notifier = new WebNotifier();

        await notifier.notify({title: 'Ada', body: 'ping', tag: 'conv-1'});

        expect(showNotification).toHaveBeenCalledWith(
            'Ada',
            expect.objectContaining({body: 'ping', tag: 'conv-1'}),
        );
    });

    it('degrades with a warning when neither the constructor nor a worker is available', async () => {
        // The honest outcome: no notification, said once, and no exception into the caller.
        installNotification(IllegalConstructorNotification);
        const notifier = new WebNotifier();

        await expect(notifier.notify({title: 'Ada', body: 'ping'})).resolves.toBeUndefined();
        await notifier.notify({title: 'Ada', body: 'again'});

        expect(console.warn).toHaveBeenCalledTimes(1);
    });

    it('registers no service worker of its own', async () => {
        // Installing one as a side effect of a toast would change the app's caching and update
        // behaviour from inside a notification call.
        const register = vi.fn();
        Object.defineProperty(navigator, 'serviceWorker', {
            configurable: true,
            value: {getRegistration: async () => undefined, register},
        });
        installNotification(IllegalConstructorNotification);
        const notifier = new WebNotifier();

        await notifier.notify({title: 'Ada', body: 'ping'});

        expect(register).not.toHaveBeenCalled();
    });
});

describe('activation', () => {
    it('hands the tag back on click and pulls the tab forward', async () => {
        const focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
        const notifier = new WebNotifier();
        const seen: string[] = [];
        await notifier.onActivated(tag => seen.push(tag));

        await notifier.notify({title: 'Ada', body: 'ping', tag: 'conv-1'});
        FakeNotification.constructed[0].onclick?.();

        expect(seen).toEqual(['conv-1']);
        // A background tab is what the user clicked away from; routing them there unseen is the same
        // bug as navigating a desktop window that stays behind.
        expect(focus).toHaveBeenCalled();
    });

    it('stops delivering after unsubscribe', async () => {
        const vi_focus = vi.spyOn(window, 'focus').mockImplementation(() => undefined);
        const notifier = new WebNotifier();
        const seen: string[] = [];
        const off = await notifier.onActivated(tag => seen.push(tag));

        off();
        await notifier.notify({title: 'Ada', body: 'ping', tag: 'conv-1'});
        FakeNotification.constructed[0].onclick?.();

        expect(seen).toEqual([]);
        expect(vi_focus).toHaveBeenCalled();
    });
});

describe('push', () => {
    it('names WebPush as the transport it would speak', () => {
        // Different from a null kind, which means "this host takes no push at all".
        expect(new WebNotifier().pushTokenKind()).toBe('WebPush');
    });

    it('mints no token, because Web Push does not exist on this client yet', async () => {
        // Needs a service worker, VAPID keys and a server that accepts a third kind - none of which
        // are client-side work. `UserTokenService` treats null as "register nothing", which is what
        // keeps a device row with an unusable transport off the server.
        await expect(new WebNotifier().pushToken()).resolves.toBeNull();
    });
});
