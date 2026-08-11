/**
 * Which push transport a device registers with.
 *
 * <p>`WebPush` is new and the server does not mint it yet - `user-token.service.ts` knows only
 * `Fcm` and `ApnsVoip`. It is declared here because the client half is what makes the gap visible;
 * see the Backend dependencies section of the browser-only build design.</p>
 */
export type PushTokenKind = 'Fcm' | 'ApnsVoip' | 'WebPush';

/**
 * Toasts and push registration.
 *
 * <p>Two halves that look unrelated and are not: whether a notification can be *shown* and whether
 * a token can be *minted* are both properties of the same host permission, and a caller that got
 * them from two services would ask twice and be told two different things.</p>
 */
export abstract class Notifier {
    abstract requestPermission(): Promise<boolean>;

    abstract notify(n: {title: string; body: string; iconUrl?: string; tag?: string}): Promise<void>;

    /** Null when this host registers for no push at all. */
    abstract pushTokenKind(): PushTokenKind | null;

    abstract pushToken(): Promise<string | null>;

    /**
     * Subscribe to the user clicking a notification. Resolves to its own unsubscribe.
     *
     * <p>The handler receives the `tag` the notification was posted under, which is the only thing
     * both hosts can carry through: desktop action types and Web Push `notificationclick` data have
     * nothing else in common.</p>
     */
    abstract onActivated(handler: (tag: string) => void): Promise<() => void>;
}
