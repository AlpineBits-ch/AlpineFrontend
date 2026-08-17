/** Which push transport a device registers with. The server does not mint `WebPush` yet. */
export type PushTokenKind = 'Fcm' | 'ApnsVoip' | 'WebPush';

/** Toasts and push registration, together because both hang off one host permission. */
export abstract class Notifier {
    abstract requestPermission(): Promise<boolean>;

    abstract notify(n: {title: string; body: string; iconUrl?: string; tag?: string}): Promise<void>;

    /** Null when this host registers for no push at all. */
    abstract pushTokenKind(): PushTokenKind | null;

    abstract pushToken(): Promise<string | null>;

    /**
     * Subscribe to the user clicking a notification. Resolves to its own unsubscribe.
     *
     * The handler receives the `tag` it was posted under, the only thing both hosts carry through.
     */
    abstract onActivated(handler: (tag: string) => void): Promise<() => void>;
}
