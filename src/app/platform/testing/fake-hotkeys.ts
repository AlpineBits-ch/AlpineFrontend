import {HotkeyHandlers, Hotkeys} from '../ports/hotkeys.port';

/** One live registration, as the fake holds it. */
export interface FakeBinding {
    id: string;
    accelerator: string;
    handlers: HotkeyHandlers;
    /** Whether the key is currently held, so a double {@link FakeHotkeys.press} cannot double-fire. */
    isDown: boolean;
}

/**
 * A {@link Hotkeys} for specs, provided in TestBed in place of an adapter.
 *
 * <p>Attaches <b>no DOM listener and no global shortcut</b>, which is the point: the desktop adapter
 * registers with the OS and the web one listens on `window` in the capture phase, and a spec that let
 * either through would have the runner's own keystrokes in its assertions.</p>
 *
 * <p>Both booleans default to the desktop answer (`global` and `focused` true) and both are mutable, so
 * "this host cannot reach a key while a game has focus" is one line. That pair is the whole reason this
 * port exists - see its header - and a spec asserting the VAD substitute sets `global = false`.</p>
 *
 * <p>{@link press} and {@link release} are what a module mock could never offer: they fire the edges the
 * caller registered, so push-to-talk's *release* path - the one that leaves a microphone open forever
 * when it is missed - is reachable from a test. They debounce through `isDown` exactly as both adapters
 * do, so a repeated press is one `onDown`.</p>
 */
export class FakeHotkeys extends Hotkeys {
    /** Mutable so one spec covers both hosts. False is the browser: nothing fires while unfocused. */
    global = true;

    /** True on every host that has a keyboard at all. */
    focused = true;

    /** Every `bind` asked for, in order, including rebinds of an id already held. */
    readonly binds: {id: string; accelerator: string}[] = [];

    /** Every `unbind` asked for, in order. */
    readonly unbinds: string[] = [];

    /** Every `beginCapture` asked for, in order. */
    readonly captures: string[] = [];

    /** How many times a capture was cancelled. */
    cancelledCaptures = 0;

    /**
     * Accelerators this host refuses, answered as `false` from {@link bind}.
     *
     * <p>Models the real refusals: an accelerator another process already owns on desktop, and the
     * native hook's mouse buttons and raw `VK123` tokens in a browser. A caller that treats `false` as
     * success is how a keybind ends up appearing to register and never firing.</p>
     */
    readonly refuse = new Set<string>();

    /** Overrides for {@link label}. Anything absent is answered with the accelerator unchanged. */
    readonly labels = new Map<string, string>();

    private readonly bindings = new Map<string, FakeBinding>();

    async bind(id: string, accelerator: string, handlers: HotkeyHandlers): Promise<boolean> {
        this.binds.push({id, accelerator});

        // Replaces whatever the id held, and pays out its release first - a binding dropped while held
        // still owes an `onUp`, or the caller's gate stays open with nothing left to close it.
        this.releaseIfHeld(id);

        if (this.refuse.has(accelerator)) {
            this.bindings.delete(id);
            return false;
        }

        this.bindings.set(id, {id, accelerator, handlers, isDown: false});
        return true;
    }

    async unbind(id: string): Promise<void> {
        this.unbinds.push(id);
        this.releaseIfHeld(id);
        this.bindings.delete(id);
    }

    /**
     * The accelerator as written, unless {@link labels} says otherwise.
     *
     * <p>Deliberately not routed through `formatAccelerator`: how an accelerator reads to a human is the
     * accelerator module's own contract and is tested there, and a fake that reformatted would put that
     * module's opinion inside every caller's assertions.</p>
     */
    async label(accelerator: string): Promise<string> {
        return this.labels.get(accelerator) ?? accelerator;
    }

    async beginCapture(id: string): Promise<void> {
        this.captures.push(id);
    }

    async cancelCapture(): Promise<void> {
        this.cancelledCaptures++;
    }

    /** The binding registered under `id`, or undefined - a refused bind leaves none. */
    binding(id: string): FakeBinding | undefined {
        return this.bindings.get(id);
    }

    /** Every id currently bound, in registration order. */
    boundIds(): string[] {
        return [...this.bindings.keys()];
    }

    /**
     * Fires the press edge for `id`, once per real transition.
     *
     * <p>Throws for an id nothing bound: "the key fired" on a binding that was never taken is the
     * assertion most worth failing loudly, because it is what a swallowed `bind` returning false looks
     * like from the outside.</p>
     */
    press(id: string): void {
        const binding = this.require(id);
        if (binding.isDown) return;
        binding.isDown = true;
        binding.handlers.onDown?.();
    }

    /** Fires the release edge for `id`. A release with no press is a no-op, as on both hosts. */
    release(id: string): void {
        const binding = this.require(id);
        if (!binding.isDown) return;
        binding.isDown = false;
        binding.handlers.onUp?.();
    }

    /** Press and release in one go, for a binding that only cares about `onDown`. */
    tap(id: string): void {
        this.press(id);
        this.release(id);
    }

    /**
     * Releases every held binding without unbinding anything.
     *
     * <p>What the web adapter does on `blur` and `visibilitychange`, and the case worth exercising: if a
     * held key's release is never delivered the microphone stays open for as long as the user is away.</p>
     */
    releaseAll(): void {
        for (const binding of this.bindings.values()) {
            if (!binding.isDown) continue;
            binding.isDown = false;
            binding.handlers.onUp?.();
        }
    }

    private releaseIfHeld(id: string): void {
        const binding = this.bindings.get(id);
        if (!binding?.isDown) return;
        binding.isDown = false;
        binding.handlers.onUp?.();
    }

    private require(id: string): FakeBinding {
        const binding = this.bindings.get(id);
        if (!binding) throw new Error(`nothing is bound under '${id}'`);
        return binding;
    }
}
