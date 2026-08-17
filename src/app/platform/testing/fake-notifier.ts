import {Notifier, PushTokenKind} from '../ports/notifier.port';

/**
 * A {@link Notifier} for specs, provided in TestBed in place of an adapter.
 *
 * <p>This is what the design spec means by "fake adapters for every port": the specs that used to
 * `vi.mock('@choochmeque/tauri-plugin-notifications-api')` and `vi.mock('@tauri-apps/plugin-os')` now
 * provide one of these instead. The difference is not tidiness - a module mock pins the *desktop*
 * plugin's behaviour, so a browser-shaped answer (no push token, a durable permission refusal) could
 * not be expressed at all, and those are the two paths most worth testing.</p>
 *
 * <p>Everything is a public field so a test states the host it means in one line. Defaults describe a
 * granted desktop host with Firebase push, which is what most tests want as a baseline.</p>
 */
export class FakeNotifier extends Notifier {
    /** What {@link requestPermission} answers. Set false for a browser that has refused. */
    permissionGranted = true;

    /** How many times permission was asked. A durable refusal must not be re-asked per message. */
    permissionRequests = 0;

    /** What {@link pushToken} resolves to. Null is the browser: no Web Push transport exists yet. */
    token: string | null = 'push-token-xyz';

    /** What {@link pushTokenKind} answers. `WebPush` alongside a null {@link token} is the web host. */
    kind: PushTokenKind | null = 'Fcm';

    /**
     * Set to make {@link pushToken} reject, which is what the desktop plugin does on a host with no
     * push backend at all - Windows, macOS and Linux desktop included.
     */
    tokenError: unknown = null;

    /** Set to make {@link onActivated} reject, standing in for a host that reports no activations. */
    activationError: unknown = null;

    /** Every notification handed to the port, in order. */
    readonly notifications: {title: string; body: string; iconUrl?: string; tag?: string}[] = [];

    private readonly handlers = new Set<(tag: string) => void>();

    async requestPermission(): Promise<boolean> {
        this.permissionRequests++;
        return this.permissionGranted;
    }

    async notify(n: {title: string; body: string; iconUrl?: string; tag?: string}): Promise<void> {
        this.notifications.push(n);
    }

    pushTokenKind(): PushTokenKind | null {
        return this.kind;
    }

    async pushToken(): Promise<string | null> {
        if (this.tokenError) throw this.tokenError;
        return this.token;
    }

    async onActivated(handler: (tag: string) => void): Promise<() => void> {
        if (this.activationError) throw this.activationError;
        this.handlers.add(handler);
        return () => void this.handlers.delete(handler);
    }

    /** Simulates the user clicking a notification posted under `tag`. */
    activate(tag: string): void {
        for (const handler of [...this.handlers]) handler(tag);
    }

    /** Whether anything is listening for activations. */
    get activationHandlerCount(): number {
        return this.handlers.size;
    }
}
