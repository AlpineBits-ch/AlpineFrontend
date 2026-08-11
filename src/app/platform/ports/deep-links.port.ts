/**
 * `venta://` links that arrive from outside the app.
 *
 * <p>The reason this is a port at all rather than a guarded call: `app.component.ts` imports
 * `@tauri-apps/plugin-deep-link` *statically*, so the module is evaluated during bootstrap and a
 * browser boot dies there before anything renders. Behind a port the plugin is `import()`ed by the
 * Tauri adapter on first use and the web bundle never references it.</p>
 */
export abstract class DeepLinks {
    /** URL the process was launched with, once. Null on web (the address bar is the launch URL). */
    abstract initial(): Promise<string | null>;

    /**
     * Subscribe to links delivered while the app is already running.
     *
     * <p>Resolves to its own unsubscribe. Async because registering the listener is an IPC round
     * trip on desktop; the web adapter resolves a no-op teardown immediately.</p>
     */
    abstract onOpen(handler: (urls: string[]) => void): Promise<() => void>;
}
