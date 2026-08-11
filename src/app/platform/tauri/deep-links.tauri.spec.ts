/**
 * The desktop deep-link adapter, and specifically its once-per-process guard.
 *
 * <p>That guard is the whole reason this file exists. `getCurrent()` keeps returning the same launch URL
 * for the life of the OS process, so without it a plain reload (Ctrl+F5) re-handles the link and reopens
 * whatever dialog it triggered - an invite dialog that comes back every refresh. The guard used to sit in
 * `app.component.ts`; the port promises "once", so it belongs to whichever adapter has to keep that
 * promise.</p>
 *
 * <p>A reload is modelled as "a new adapter, `sessionStorage` kept", which is what a new document is -
 * `providePlatform()` builds one adapter per injector. A relaunch clears `sessionStorage` as well.</p>
 */

const {getCurrent, onOpenUrl} = vi.hoisted(() => ({getCurrent: vi.fn(), onOpenUrl: vi.fn()}));

vi.mock('@tauri-apps/plugin-deep-link', () => ({
    getCurrent: () => getCurrent(),
    onOpenUrl: (handler: unknown) => onOpenUrl(handler),
}));

import {TauriDeepLinks} from './deep-links.tauri';

const LAUNCH_URL = 'venta://invite/abc123';

/**
 * A new adapter in a new document - i.e. after a reload.
 *
 * <p>`sessionStorage` is deliberately not cleared: it is what survives a reload and carries the guard
 * across one. A fresh adapter is what a new document produces, because `providePlatform()` builds one
 * per injector.</p>
 */
function reloadedAdapter(): TauriDeepLinks {
    return new TauriDeepLinks();
}

/** A cold process: a new adapter and no session storage from a previous document. */
function launchedAdapter(): TauriDeepLinks {
    sessionStorage.clear();
    return reloadedAdapter();
}

beforeEach(() => {
    getCurrent.mockReset();
    onOpenUrl.mockReset();
    getCurrent.mockResolvedValue([LAUNCH_URL]);
    onOpenUrl.mockResolvedValue(() => undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
});

describe('TauriDeepLinks.initial', () => {
    it('reports the URL the process was launched with', async () => {
        const links = launchedAdapter();

        expect(await links.initial()).toBe(LAUNCH_URL);
    });

    it('reports nothing when the process was not launched from a link', async () => {
        const links = launchedAdapter();
        getCurrent.mockResolvedValue(null);

        expect(await links.initial()).toBeNull();
    });

    /** A launch carries one link. The array is the plugin's shape, not a queue to drain. */
    it('takes the first URL when the plugin reports several', async () => {
        const links = launchedAdapter();
        getCurrent.mockResolvedValue([LAUNCH_URL, 'venta://install-bot?id=2']);

        expect(await links.initial()).toBe(LAUNCH_URL);
    });

    it('answers once per adapter', async () => {
        const links = launchedAdapter();

        expect(await links.initial()).toBe(LAUNCH_URL);
        expect(await links.initial()).toBeNull();
    });

    /** The case the guard exists for: the plugin still has the URL, and the app must not re-handle it. */
    it('answers nothing after a reload, even though the plugin still reports the URL', async () => {
        expect(await launchedAdapter().initial()).toBe(LAUNCH_URL);

        const afterReload = reloadedAdapter();

        expect(await afterReload.initial()).toBeNull();
        expect(getCurrent).toHaveBeenCalledTimes(1);
    });

    /** A relaunch is a new process, and a new process gets its launch URL. */
    it('answers again after a relaunch', async () => {
        expect(await launchedAdapter().initial()).toBe(LAUNCH_URL);

        expect(await launchedAdapter().initial()).toBe(LAUNCH_URL);
    });

    /**
     * The flag is set before anything is awaited, so two callers racing cannot both be handed the link -
     * which would open the invite dialog twice.
     */
    it('hands the URL to only one of two concurrent callers', async () => {
        const links = launchedAdapter();

        const answers = await Promise.all([links.initial(), links.initial()]);

        expect(answers.filter(url => url !== null)).toEqual([LAUNCH_URL]);
    });

    /**
     * Where `sessionStorage` throws - some private-browsing modes - the guard degrades to
     * once-per-document rather than dropping the link entirely. Repeating a link on a manual reload is
     * a smaller failure than never handling a cold-start link at all.
     */
    it('still answers once per document when session storage is unusable', async () => {
        const links = launchedAdapter();
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('session storage is disabled');
        });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('session storage is disabled');
        });

        expect(await links.initial()).toBe(LAUNCH_URL);
        expect(await links.initial()).toBeNull();
    });
});

describe('TauriDeepLinks.onOpen', () => {
    it('subscribes through the plugin and resolves its unsubscribe', async () => {
        const links = launchedAdapter();
        const unlisten = vi.fn();
        onOpenUrl.mockResolvedValue(unlisten);
        const handler = vi.fn();

        const stop = await links.onOpen(handler);
        stop();

        expect(onOpenUrl).toHaveBeenCalledWith(handler);
        expect(unlisten).toHaveBeenCalled();
    });

    /** Links arriving while the app runs are not rationed - the guard is only about the launch URL. */
    it('does not consume the launch URL', async () => {
        const links = launchedAdapter();

        await links.onOpen(() => undefined);

        expect(await links.initial()).toBe(LAUNCH_URL);
    });
});
