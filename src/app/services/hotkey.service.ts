import {inject, Injectable} from '@angular/core';
import {HotkeyHandlers, Hotkeys} from '../platform/ports/hotkeys.port';

/**
 * Generic hotkey foundation, now a thin delegate over the {@link Hotkeys} port.
 *
 * <p>On desktop this is what it always was: OS-level accelerators from the global-shortcut plugin,
 * which fire even when the app window is NOT focused - required for push-to-talk while the game (not
 * Echo) has focus. A registered accelerator is captured OS-wide, so bindings should only be held while
 * actually needed (e.g. while proximity voice is connected).</p>
 *
 * <p><b>In a browser the reach is different and the API is not.</b> The web adapter binds `keydown`, so
 * a hotkey works while Alpine itself is focused and cannot work while anything else is - no web API
 * fires while the tab is unfocused. Which of those a caller is entitled to assume is
 * `Hotkeys.global` / `Hotkeys.focused`, or `PlatformCapabilities.globalHotkeys` for a template; see
 * {@link supported} for why this service does not answer that question.</p>
 *
 * <p>The public surface is unchanged on purpose - `call-hotkey.service.ts` and
 * `isle-proximity.service.ts` consume it and are owned by other work in flight. Per the design spec, a
 * port does not replace the service that uses it.</p>
 */

/** Re-exported so callers keep importing it from here. Defined with the port it belongs to. */
export type {HotkeyHandlers};

@Injectable({providedIn: 'root'})
export class HotkeyService {
    private readonly hotkeys = inject(Hotkeys);

    /**
     * Whether *some* hotkey mechanism exists on this host - not whether it reaches past the app.
     *
     * <p>This used to be `isTauri()`, and the two questions were the same answer only because there was
     * one implementation. They are different questions now, and this is the narrow one: callers guard
     * `bind` with it (`call-hotkey.service.ts:134`, `isle-proximity.service.ts:349`) and treat false as
     * "no hotkey mechanism, so nothing was armed". A browser *can* bind, so answering false there would
     * be wrong in a specific and bad way: `armAction` would report the key unbound, and both callers
     * compute their microphone gate as "open unless a push-to-talk key is bound and not held". An
     * unbound push-to-talk key means <b>a permanently open microphone</b> - the user set a PTT key, the
     * client quietly ignored it, and everyone hears everything.</p>
     *
     * <p>The converse risk is real and smaller: with a PTT key bound in a browser, the user cannot
     * transmit while another window has focus, because the key press never arrives. That is the honest
     * shape of the platform, it is what `Hotkeys.global = false` and
     * `PlatformCapabilities.globalHotkeys = false` announce to the UI, and voice activity detection is
     * the substitute the design spec names. A closed microphone with a stated reason beats a hot one
     * nobody asked for.</p>
     *
     * <p>Written as `global || focused` rather than `true` so a host that can do neither still gets the
     * fallback path those call sites already have.</p>
     */
    get supported(): boolean {
        return this.hotkeys.global || this.hotkeys.focused;
    }

    /**
     * Register (or re-register) a hotkey under a logical `id`. Re-binding the same id transparently
     * releases the previous accelerator first.
     *
     * <p>Still `Promise<void>`: the port reports whether the binding was taken, but widening this would
     * change a signature two files owned by other tracks call. The port's boolean is available to
     * whoever migrates them off this delegate.</p>
     */
    async bind(id: string, accelerator: string, handlers: HotkeyHandlers): Promise<void> {
        await this.hotkeys.bind(id, accelerator, handlers);
    }

    async unbind(id: string): Promise<void> {
        await this.hotkeys.unbind(id);
    }
}
