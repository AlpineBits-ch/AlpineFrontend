/**
 * The four desktop-only web adapters, held to one rule: **reads answer, writes reject.**
 *
 * <p>A resolved write is the bug this whole design exists to prevent. `minimize()` resolving says the
 * window was minimised; `setEnabled(true)` resolving says the app will start with the machine;
 * `rpcStart()` resolving with a status says a socket was bound. None of those can be told apart from
 * the real thing by a caller, so each becomes a control that moves and does nothing - the failure
 * `activity-settings.component.ts` documents and `provide-platform.ts`'s `notWired` was written to
 * avoid.</p>
 *
 * <p>Reads are different: "not maximised", "no launch entry", "nothing detected" are all true of a
 * browser tab, so answering them is honest rather than a stub. The point of this file is that the line
 * between the two is asserted rather than assumed - and that `supported` is false everywhere, because
 * every one of these rejections is unreachable if callers gate on it.</p>
 */
import {WebAutostart} from './autostart.web';
import {WebPresence} from './presence.web';
import {WebPresenceCatalog} from './presence-catalog.web';
import {WebUpdater} from './updater.web';
import {WebWindowChrome} from './window-chrome.web';

describe('the desktop-only web adapters', () => {
    it('all report themselves unsupported', () => {
        expect(new WebWindowChrome().supported).toBe(false);
        expect(new WebPresence().supported).toBe(false);
        expect(new WebPresenceCatalog().supported).toBe(false);
        expect(new WebUpdater().supported).toBe(false);
        expect(new WebAutostart().supported).toBe(false);
    });
});

describe('WebWindowChrome', () => {
    it('answers the frame questions with the truth about a tab', async () => {
        const chrome = new WebWindowChrome();

        await expect(chrome.isFlush()).resolves.toBe(false);
        await expect(chrome.isMaximized()).resolves.toBe(false);
    });

    /** A real unsubscribe, so teardown does not have to special-case the host. */
    it('hands back working unsubscribes for events it will never fire', async () => {
        const chrome = new WebWindowChrome();

        const unResize = await chrome.onResized(() => undefined);
        const unClose = await chrome.onCloseRequested(() => undefined);

        expect(unResize).toBeTypeOf('function');
        expect(unClose).toBeTypeOf('function');
        expect(() => {
            unResize();
            unClose();
        }).not.toThrow();
    });

    it('rejects every window command rather than pretending it happened', async () => {
        const chrome = new WebWindowChrome();

        await expect(chrome.minimize()).rejects.toThrow(/desktop-only/);
        await expect(chrome.toggleMaximize()).rejects.toThrow(/desktop-only/);
        await expect(chrome.close()).rejects.toThrow(/desktop-only/);
        await expect(chrome.startDragging()).rejects.toThrow(/desktop-only/);
        await expect(chrome.startResizeDragging('South')).rejects.toThrow(/desktop-only/);
    });
});

describe('WebPresence', () => {
    it('detects nothing, which is the honest answer rather than a stub', async () => {
        const presence = new WebPresence();

        await expect(presence.current()).resolves.toEqual([]);
        await expect(presence.scan()).resolves.toBeNull();
        await expect(presence.onChanged(() => undefined)).resolves.toBeTypeOf('function');
    });

    /**
     * A `PresenceRpcStatus` is a claim about a machine-wide socket. `running: true` would be a lie, and
     * `running: false` reads as "I stopped it for you" - so neither is available.
     */
    it('rejects the RPC pair rather than describing a socket it never bound', async () => {
        const presence = new WebPresence();

        await expect(presence.rpcStart('proxy')).rejects.toThrow(/desktop-only/);
        await expect(presence.rpcStop()).rejects.toThrow(/desktop-only/);
    });
});

describe('WebPresenceCatalog', () => {
    /**
     * `state()` must not answer `{loaded: false, etag: null}`: that reads as "nothing cached, go and
     * fetch it" and would put a 12 MB conditional request on every web session forever, for a matcher
     * that does not exist on this host.
     */
    it('rejects rather than reporting an empty cache worth filling', async () => {
        const catalog = new WebPresenceCatalog();

        await expect(catalog.state()).rejects.toThrow(/desktop-only/);
        await expect(catalog.load('{}', null)).rejects.toThrow(/desktop-only/);
    });
});

describe('WebUpdater', () => {
    /** The load-bearing one. See `update.service.spec.ts` for the same property through the service. */
    it('rejects check() instead of resolving null, which would mean "you are up to date"', async () => {
        const updater = new WebUpdater();

        await expect(updater.check()).rejects.toThrow(/desktop-only/);
        await expect(updater.downloadAndInstall()).rejects.toThrow(/desktop-only/);
    });
});

describe('WebAutostart', () => {
    it('reports the launch entry it does not have, and refuses to write one', async () => {
        const autostart = new WebAutostart();

        await expect(autostart.isEnabled()).resolves.toBe(false);
        await expect(autostart.setEnabled(true)).rejects.toThrow(/desktop-only/);
        await expect(autostart.setEnabled(false)).rejects.toThrow(/desktop-only/);
    });
});
