/**
 * `venta://` links that arrive from outside the app.
 *
 * The plugin must stay behind an `import()` in the Tauri adapter: a static import kills a browser
 * boot during bootstrap.
 */
export abstract class DeepLinks {
    /** URL the process was launched with, once. Null on web (the address bar is the launch URL). */
    abstract initial(): Promise<string | null>;

    /** Subscribe to links delivered while the app is already running. Resolves to its own unsubscribe. */
    abstract onOpen(handler: (urls: string[]) => void): Promise<() => void>;
}
