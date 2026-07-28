//! Push-to-talk via a native low-level input hook.
//!
//! The Tauri global-shortcut plugin only supports keyboard accelerators with a
//! non-modifier base key, so it can't bind a bare modifier (Ctrl) or a mouse
//! button -both of which players expect for PTT. This module installs Windows
//! low-level keyboard + mouse hooks (`WH_KEYBOARD_LL` / `WH_MOUSE_LL`) that see
//! raw key/mouse transitions regardless of which window is focused, and emits
//! `ptt-down` / `ptt-up` events to the frontend.
//!
//! Non-Windows targets fall back to the global-shortcut plugin on the frontend;
//! the commands here are compiled as no-ops there so the command set is uniform
//! and Linux/macOS keep building.
//!
//! ## Slots
//!
//! The hook holds [`SLOT_COUNT`] independent bindings, shared by two frontend
//! features that each own a fixed slot range: Isle proximity voice (slots
//! 0-2: push-to-talk, toggle-mute, push-to-mute) and in-app Voice Calls
//! (slots 3-5: the same three, for `CallHotkeyService`). Voice Calls moved
//! onto this hook rather than the OS global-shortcut plugin because
//! `RegisterHotKey`-backed accelerators swallow the key system-wide,
//! including inside Alpine's own text inputs, for as long as they're
//! registered - which broke typing a bare-letter PTT key (e.g. `T`) anywhere
//! while in a call. This hook's keyboard proc never swallows a keystroke
//! (see `handle_key`), so it has no such side effect. Every piece of
//! per-binding state below is a fixed-size array indexed by slot instead of
//! a scalar, but the concurrency story is unchanged - still plain atomics,
//! still no locking on the input path.
//!
//! Binding token format (stored in settings, `+`-joined):
//!   modifiers: `Ctrl` `Alt` `Shift` `Win`
//!   main:      `VK<code>` (virtual-key), `MouseX1` `MouseX2` `MouseMid`,
//!              or -for a bare modifier -just the single modifier name.
//!   examples:  `Ctrl+VK86` (Ctrl+V), `VK118` (F7), `MouseX2`, `Ctrl`
//!
//! ## The load-bearing invariant: the hook procedure never blocks
//!
//! A low-level hook procedure runs *inline on the system raw-input path*. Until
//! it returns, NO process on the machine receives keyboard or mouse input, and
//! if it overruns `LowLevelHooksTimeout` (300 ms by default) Windows silently
//! rips the hook out. So the hook procs below must never do anything that can
//! block or take unbounded time:
//!
//!   * no mutexes -all shared state lives in atomics,
//!   * no allocation -events go through a fixed-size lock-free ring,
//!   * no Tauri/IPC -a worker thread owns the `AppHandle` and does all emitting,
//!   * no unwinding -the body is wrapped in `catch_unwind`,
//!   * no unbounded syscalls -the foreground-window lookup is HWND-cached.
//!
//! Everything that *can* take time (emitting, timeouts, watchdogs) runs on the
//! worker thread instead. A worker stall then costs voice latency, never input.

#[cfg(target_os = "windows")]
mod imp {
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, AtomicUsize, Ordering};
    use std::sync::OnceLock;
    use std::thread;
    use std::time::{Duration, Instant};

    use serde::Serialize;
    use tauri::{AppHandle, Emitter};

    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Threading::{
        GetCurrentProcessId, GetCurrentThread, GetCurrentThreadId, SetThreadPriority,
        THREAD_PRIORITY_TIME_CRITICAL,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, GetLastInputInfo, LASTINPUTINFO, VK_CONTROL, VK_LWIN, VK_MBUTTON,
        VK_MENU, VK_RWIN, VK_SHIFT, VK_XBUTTON1, VK_XBUTTON2,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId,
        SetWindowsHookExW, UnhookWindowsHookEx, HHOOK, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT,
        WH_KEYBOARD_LL, WH_MOUSE_LL, WM_APP, WM_KEYDOWN, WM_KEYUP, WM_MBUTTONDOWN, WM_MBUTTONUP,
        WM_SYSKEYDOWN, WM_SYSKEYUP, WM_XBUTTONDOWN, WM_XBUTTONUP,
    };

    const XBUTTON1: u16 = 0x0001;
    const XBUTTON2: u16 = 0x0002;

    /// Capture mode swallows every keystroke system-wide, so it must be able to
    /// end on its own -a frontend that closes, crashes or reloads mid-capture
    /// must not leave the machine eating input forever.
    const CAPTURE_TIMEOUT: Duration = Duration::from_secs(15);
    /// Worker tick. Doubles as the resolution of the stuck-press watchdog.
    const TICK: Duration = Duration::from_millis(50);
    /// How often to check that the hooks are still alive.
    const HEALTH_INTERVAL: Duration = Duration::from_secs(1);
    /// Consecutive health checks that must disagree before reinstalling. Guards
    /// against a single sample racing an input event.
    const HEALTH_STRIKES: u32 = 3;
    /// Posted to the hook thread to make it reinstall its hooks.
    const WM_PTT_REHOOK: u32 = WM_APP + 1;

    #[derive(Clone, Copy, PartialEq)]
    enum ModKey {
        Ctrl,
        Alt,
        Shift,
        Win,
    }

    #[derive(Clone, Copy, PartialEq)]
    enum Main {
        Key(u32),
        MouseX1,
        MouseX2,
        MouseMid,
        Modifier(ModKey),
    }

    #[derive(Clone, Copy)]
    struct Binding {
        ctrl: bool,
        alt: bool,
        shift: bool,
        win: bool,
        main: Main,
    }

    #[derive(Serialize, Clone)]
    struct CaptureResult {
        slot: u8,
        token: String,
        label: String,
        cancelled: bool,
    }

    #[derive(Serialize, Clone)]
    struct EdgeEvent {
        slot: u8,
    }

    /// Number of independent bindings the hook tracks: 0-2 are Isle proximity
    /// voice (push-to-talk, toggle-mute, push-to-mute), 3-5 are the same three
    /// for in-app Voice Calls (`CallHotkeyService`). Bump this to add another -
    /// every other piece of per-slot state is a `[T; SLOT_COUNT]` array already.
    const SLOT_COUNT: usize = 6;

    // ── Shared state ────────────────────────────────────────────────────────
    //
    // Atomics only. The hook procedures read/write these with plain loads and
    // stores, so an input event can never wait on another thread. One element
    // per slot, indexed by the `slot` argument the frontend passes in.

    static INITIALISED: AtomicBool = AtomicBool::new(false);
    static ARMED: [AtomicBool; SLOT_COUNT] = [const { AtomicBool::new(false) }; SLOT_COUNT];
    static PRESSED: [AtomicBool; SLOT_COUNT] = [const { AtomicBool::new(false) }; SLOT_COUNT];
    static CAPTURING: AtomicBool = AtomicBool::new(false);
    /// Which slot a capture-in-progress will write its result into.
    static CAPTURE_SLOT: AtomicU8 = AtomicU8::new(0);
    /// The active binding per slot, packed by [`pack`]. 0 = no binding.
    static BINDING: [AtomicU64; SLOT_COUNT] = [const { AtomicU64::new(0) }; SLOT_COUNT];
    /// Bare-modifier candidate during capture ([`mod_code`], 0 = none).
    static CAPTURE_MOD: AtomicU32 = AtomicU32::new(0);
    /// Capture deadline, ms since [`START`]. 0 = not capturing.
    static CAPTURE_DEADLINE: AtomicU64 = AtomicU64::new(0);

    /// Per-button record of whether we swallowed the *press*, so the matching
    /// *release* is swallowed with it. Without this, a focus change between down
    /// and up leaks a half-transition and leaves the other app convinced the
    /// button is still held -the "stuck mouse button" bug.
    static ATE_X1: AtomicBool = AtomicBool::new(false);
    static ATE_X2: AtomicBool = AtomicBool::new(false);
    static ATE_MID: AtomicBool = AtomicBool::new(false);

    /// Foreground-window cache: `GetWindowThreadProcessId` is a kernel call, so
    /// only make it when the foreground HWND actually changed. Only the hook
    /// thread touches these.
    static FG_HWND: AtomicUsize = AtomicUsize::new(0);
    static FG_SELF: AtomicBool = AtomicBool::new(false);

    /// Bumped by every hook callback; the worker uses it to notice that Windows
    /// has silently unhooked us.
    static HOOK_CALLS: AtomicU32 = AtomicU32::new(0);
    /// Thread id of the live hook thread; 0 once its message loop has exited.
    static HOOK_THREAD_ID: AtomicU32 = AtomicU32::new(0);
    /// Set while a hook thread is starting, so the watchdog can't spawn two.
    static HOOK_STARTING: AtomicBool = AtomicBool::new(false);

    static START: OnceLock<Instant> = OnceLock::new();
    static WORKER: OnceLock<thread::Thread> = OnceLock::new();

    fn now_ms() -> u64 {
        START.get().map(|s| s.elapsed().as_millis() as u64).unwrap_or(0)
    }

    // ── Event ring (hook → worker) ──────────────────────────────────────────

    const EV_DOWN: u64 = 1;
    const EV_UP: u64 = 2;
    const EV_CAPTURE: u64 = 3;
    const EV_CAPTURE_CANCEL: u64 = 4;

    const RING_CAP: usize = 128;

    /// Bounded lock-free queue. Multi-producer (hook thread + command threads),
    /// single-consumer (the worker). Push is wait-free and allocation-free; a
    /// full ring drops the event rather than ever blocking a producer -losing a
    /// PTT edge is recoverable (the watchdog re-syncs), stalling input is not.
    struct Ring {
        data: [AtomicU64; RING_CAP],
        ready: [AtomicBool; RING_CAP],
        head: AtomicUsize,
        tail: AtomicUsize,
    }

    static RING: Ring = Ring {
        data: [const { AtomicU64::new(0) }; RING_CAP],
        ready: [const { AtomicBool::new(false) }; RING_CAP],
        head: AtomicUsize::new(0),
        tail: AtomicUsize::new(0),
    };

    impl Ring {
        fn push(&self, ev: u64) {
            let tail = self.tail.load(Ordering::Acquire);
            if self.head.load(Ordering::Relaxed).wrapping_sub(tail) >= RING_CAP {
                return; // backlogged worker: drop, never wait
            }
            // Every claimed slot is always published, so the consumer can never
            // be stranded on a half-written slot.
            let slot = self.head.fetch_add(1, Ordering::Relaxed) % RING_CAP;
            self.data[slot].store(ev, Ordering::Relaxed);
            self.ready[slot].store(true, Ordering::Release);
        }

        fn pop(&self) -> Option<u64> {
            let tail = self.tail.load(Ordering::Relaxed);
            if tail == self.head.load(Ordering::Acquire) {
                return None;
            }
            let slot = tail % RING_CAP;
            if !self.ready[slot].load(Ordering::Acquire) {
                return None; // claimed but not published yet; next tick will get it
            }
            let ev = self.data[slot].load(Ordering::Relaxed);
            self.ready[slot].store(false, Ordering::Relaxed);
            self.tail.store(tail.wrapping_add(1), Ordering::Release);
            Some(ev)
        }
    }

    /// Queue an event and nudge the worker. Safe to call from a hook procedure.
    fn emit_event(tag: u64, payload: u64) {
        RING.push(tag | (payload << 8));
        if let Some(worker) = WORKER.get() {
            worker.unpark();
        }
    }

    // ── Binding packing ─────────────────────────────────────────────────────
    //
    // A `Binding` fits in a u64 so the hook can read it with one relaxed load
    // instead of locking.

    const MAIN_KEY: u64 = 1;
    const MAIN_X1: u64 = 2;
    const MAIN_X2: u64 = 3;
    const MAIN_MID: u64 = 4;
    const MAIN_MOD: u64 = 5;

    fn mod_code(m: ModKey) -> u32 {
        match m {
            ModKey::Ctrl => 1,
            ModKey::Alt => 2,
            ModKey::Shift => 3,
            ModKey::Win => 4,
        }
    }

    fn mod_from_code(code: u32) -> Option<ModKey> {
        match code {
            1 => Some(ModKey::Ctrl),
            2 => Some(ModKey::Alt),
            3 => Some(ModKey::Shift),
            4 => Some(ModKey::Win),
            _ => None,
        }
    }

    fn pack(b: &Binding) -> u64 {
        let (kind, payload) = match b.main {
            Main::Key(k) => (MAIN_KEY, k as u64),
            Main::MouseX1 => (MAIN_X1, 0),
            Main::MouseX2 => (MAIN_X2, 0),
            Main::MouseMid => (MAIN_MID, 0),
            Main::Modifier(m) => (MAIN_MOD, mod_code(m) as u64),
        };
        1 | (b.ctrl as u64) << 1
            | (b.alt as u64) << 2
            | (b.shift as u64) << 3
            | (b.win as u64) << 4
            | kind << 8
            | payload << 16
    }

    fn unpack(v: u64) -> Option<Binding> {
        if v & 1 == 0 {
            return None;
        }
        let payload = (v >> 16) as u32;
        let main = match (v >> 8) & 0xF {
            MAIN_KEY => Main::Key(payload),
            MAIN_X1 => Main::MouseX1,
            MAIN_X2 => Main::MouseX2,
            MAIN_MID => Main::MouseMid,
            MAIN_MOD => Main::Modifier(mod_from_code(payload)?),
            _ => return None,
        };
        Some(Binding {
            ctrl: v >> 1 & 1 != 0,
            alt: v >> 2 & 1 != 0,
            shift: v >> 3 & 1 != 0,
            win: v >> 4 & 1 != 0,
            main,
        })
    }

    fn binding_now(slot: usize) -> Option<Binding> {
        unpack(BINDING[slot].load(Ordering::Relaxed))
    }

    // ── Key state helpers ───────────────────────────────────────────────────

    fn key_down(vk: i32) -> bool {
        // High-order bit of GetAsyncKeyState marks the key as currently down.
        (unsafe { GetAsyncKeyState(vk) } as u16 & 0x8000) != 0
    }

    fn mods_now() -> (bool, bool, bool, bool) {
        (
            key_down(VK_CONTROL.0 as i32),
            key_down(VK_MENU.0 as i32),
            key_down(VK_SHIFT.0 as i32),
            key_down(VK_LWIN.0 as i32) || key_down(VK_RWIN.0 as i32),
        )
    }

    fn is_modifier_vk(vk: u32) -> Option<ModKey> {
        match vk {
            0xA2 | 0xA3 | 0x11 => Some(ModKey::Ctrl), // L/R Control, Control
            0xA4 | 0xA5 | 0x12 => Some(ModKey::Alt),  // L/R Menu (Alt)
            0xA0 | 0xA1 | 0x10 => Some(ModKey::Shift), // L/R Shift
            0x5B | 0x5C => Some(ModKey::Win),         // L/R Win
            _ => None,
        }
    }

    /// Is the binding's main input physically held right now? Used by the
    /// watchdog to unstick a latched press.
    fn main_is_held(b: &Binding) -> bool {
        match b.main {
            Main::Key(k) => key_down(k as i32),
            Main::MouseX1 => key_down(VK_XBUTTON1.0 as i32),
            Main::MouseX2 => key_down(VK_XBUTTON2.0 as i32),
            Main::MouseMid => key_down(VK_MBUTTON.0 as i32),
            Main::Modifier(ModKey::Ctrl) => key_down(VK_CONTROL.0 as i32),
            Main::Modifier(ModKey::Alt) => key_down(VK_MENU.0 as i32),
            Main::Modifier(ModKey::Shift) => key_down(VK_SHIFT.0 as i32),
            Main::Modifier(ModKey::Win) => {
                key_down(VK_LWIN.0 as i32) || key_down(VK_RWIN.0 as i32)
            }
        }
    }

    // ── Public surface (called from the Tauri commands) ─────────────────────

    pub fn supported() -> bool {
        true
    }

    pub fn init(app: &AppHandle) {
        if INITIALISED.swap(true, Ordering::AcqRel) {
            return; // already initialised
        }
        let _ = START.set(Instant::now());

        spawn_worker(app.clone());
        spawn_hook_thread();
    }

    fn valid_slot(slot: u8) -> Result<usize, String> {
        let slot = slot as usize;
        if slot >= SLOT_COUNT {
            return Err(format!("invalid slot: {slot}"));
        }
        Ok(slot)
    }

    pub fn set_binding(slot: u8, token: String) -> Result<(), String> {
        let slot = valid_slot(slot)?;
        let binding = parse_token(&token).ok_or_else(|| format!("invalid binding: {token}"))?;
        BINDING[slot].store(pack(&binding), Ordering::Relaxed);
        release_if_pressed(slot);
        Ok(())
    }

    pub fn arm(slot: u8) -> Result<(), String> {
        let slot = valid_slot(slot)?;
        if BINDING[slot].load(Ordering::Relaxed) == 0 {
            return Err("no binding set".into());
        }
        release_if_pressed(slot);
        ARMED[slot].store(true, Ordering::Relaxed);
        Ok(())
    }

    pub fn disarm(slot: u8) -> Result<(), String> {
        let slot = valid_slot(slot)?;
        ARMED[slot].store(false, Ordering::Relaxed);
        release_if_pressed(slot);
        Ok(())
    }

    pub fn begin_capture(slot: u8) -> Result<(), String> {
        let slot = valid_slot(slot)?;
        CAPTURE_SLOT.store(slot as u8, Ordering::Relaxed);
        CAPTURE_MOD.store(0, Ordering::Relaxed);
        CAPTURE_DEADLINE.store(now_ms() + CAPTURE_TIMEOUT.as_millis() as u64, Ordering::Relaxed);
        CAPTURING.store(true, Ordering::Release);
        if let Some(worker) = WORKER.get() {
            worker.unpark(); // so the timeout is armed promptly
        }
        Ok(())
    }

    pub fn cancel_capture() -> Result<(), String> {
        let slot = CAPTURE_SLOT.load(Ordering::Relaxed);
        end_capture();
        emit_event(EV_CAPTURE_CANCEL, slot as u64);
        Ok(())
    }

    pub fn label(token: String) -> String {
        match parse_token(&token) {
            Some(b) => format_binding(&b),
            None => token,
        }
    }

    /// Drop a held press and tell the frontend, so the mic can never latch open
    /// across a rebind/disarm.
    fn release_if_pressed(slot: usize) {
        if PRESSED[slot].swap(false, Ordering::AcqRel) {
            emit_event(EV_UP, slot as u64);
        }
    }

    fn end_capture() {
        CAPTURING.store(false, Ordering::Release);
        CAPTURE_MOD.store(0, Ordering::Relaxed);
        CAPTURE_DEADLINE.store(0, Ordering::Relaxed);
    }

    // ── Worker thread (owns the AppHandle; the only place `emit` happens) ────

    fn spawn_worker(app: AppHandle) {
        thread::spawn(move || {
            let _ = WORKER.set(thread::current());
            let mut health_due = Instant::now() + HEALTH_INTERVAL;
            let mut last_input = 0u32;
            let mut last_calls = 0u32;
            let mut strikes = 0u32;
            let mut stuck_misses = [0u32; SLOT_COUNT];

            loop {
                // Anything queued by a hook is drained here, off the input path.
                while let Some(ev) = RING.pop() {
                    match ev & 0xFF {
                        EV_DOWN => {
                            let slot = ((ev >> 8) & 0xFF) as u8;
                            let _ = app.emit("ptt-down", EdgeEvent { slot });
                        }
                        EV_UP => {
                            let slot = ((ev >> 8) & 0xFF) as u8;
                            let _ = app.emit("ptt-up", EdgeEvent { slot });
                        }
                        EV_CAPTURE => {
                            let slot = ((ev >> 8) & 0xFF) as u8;
                            if let Some(b) = unpack(ev >> 16) {
                                let _ = app.emit(
                                    "ptt-capture",
                                    CaptureResult {
                                        slot,
                                        token: token_of(&b),
                                        label: format_binding(&b),
                                        cancelled: false,
                                    },
                                );
                            }
                        }
                        EV_CAPTURE_CANCEL => {
                            let slot = ((ev >> 8) & 0xFF) as u8;
                            let _ = app.emit(
                                "ptt-capture",
                                CaptureResult {
                                    slot,
                                    token: String::new(),
                                    label: String::new(),
                                    cancelled: true,
                                },
                            );
                        }
                        _ => {} // unknown tag: ignore
                    }
                }

                unstick_press(&mut stuck_misses);
                expire_capture();

                if Instant::now() >= health_due {
                    health_due = Instant::now() + HEALTH_INTERVAL;
                    check_hook_health(&mut last_input, &mut last_calls, &mut strikes);
                }

                thread::park_timeout(TICK);
            }
        });
    }

    /// A press can latch if its release never reaches us -the key was let go
    /// while the hook was being reinstalled, over a session switch, or under a
    /// UAC prompt (which blocks hooks entirely). Poll the physical key state and
    /// force the release, so a stuck button can never hold the mic open.
    ///
    /// Two consecutive "not held" samples are required: a hook procedure runs
    /// *before* the press reaches the async key-state table, so a tick landing in
    /// that window would otherwise cut a legitimate press short.
    fn unstick_press(misses: &mut [u32; SLOT_COUNT]) {
        for slot in 0..SLOT_COUNT {
            if !PRESSED[slot].load(Ordering::Relaxed) {
                misses[slot] = 0;
                continue;
            }
            if binding_now(slot).map(|b| main_is_held(&b)).unwrap_or(false) {
                misses[slot] = 0;
                continue;
            }
            misses[slot] += 1;
            if misses[slot] >= 2 {
                misses[slot] = 0;
                if PRESSED[slot].swap(false, Ordering::AcqRel) {
                    emit_event(EV_UP, slot as u64);
                }
            }
        }
    }

    /// Capture mode eats all keyboard input, so it is hard-bounded in time.
    fn expire_capture() {
        if !CAPTURING.load(Ordering::Acquire) {
            return;
        }
        let deadline = CAPTURE_DEADLINE.load(Ordering::Relaxed);
        if deadline != 0 && now_ms() >= deadline {
            let slot = CAPTURE_SLOT.load(Ordering::Relaxed);
            end_capture();
            emit_event(EV_CAPTURE_CANCEL, slot as u64);
        }
    }

    /// Windows removes a low-level hook that overruns `LowLevelHooksTimeout`,
    /// silently and permanently. Detect it by comparing "the system saw input"
    /// against "our hook ran", and reinstall.
    ///
    /// `GetLastInputInfo` is sampled *before* the callback counter: if input
    /// lands between the two reads the counter is already fresh, so the pair can
    /// only ever miss a real stall for one interval -never invent one.
    fn check_hook_health(last_input: &mut u32, last_calls: &mut u32, strikes: &mut u32) {
        let mut lii = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if !unsafe { GetLastInputInfo(&mut lii) }.as_bool() {
            return;
        }
        let input_now = lii.dwTime;
        let calls_now = HOOK_CALLS.load(Ordering::Relaxed);

        let input_moved = input_now != *last_input && *last_input != 0;
        let hook_silent = calls_now == *last_calls;
        *last_input = input_now;
        *last_calls = calls_now;

        if input_moved && hook_silent {
            *strikes += 1;
            if *strikes >= HEALTH_STRIKES {
                *strikes = 0;
                match HOOK_THREAD_ID.load(Ordering::Acquire) {
                    // Message loop still alive: ask it to reinstall in place.
                    tid if tid != 0 => {
                        let _ = unsafe {
                            windows::Win32::UI::WindowsAndMessaging::PostThreadMessageW(
                                tid,
                                WM_PTT_REHOOK,
                                WPARAM(0),
                                LPARAM(0),
                            )
                        };
                    }
                    // Loop is gone (WM_QUIT or a GetMessage error): start a new one
                    // rather than leaving PTT dead until the app restarts.
                    _ => spawn_hook_thread(),
                }
            }
        } else {
            *strikes = 0;
        }
    }

    // ── Hook thread ─────────────────────────────────────────────────────────

    fn spawn_hook_thread() {
        if HOOK_STARTING.swap(true, Ordering::AcqRel) {
            return; // one already coming up
        }
        thread::spawn(|| unsafe {
            // The hook procs run on this thread, and every keystroke on the
            // machine waits behind them. Keeping the thread above game/render
            // threads is what stops a loaded system from pushing us past
            // LowLevelHooksTimeout (which shows up as system-wide input hitching
            // and then a dead hook). It only ever sits in GetMessageW.
            let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
            HOOK_THREAD_ID.store(GetCurrentThreadId(), Ordering::Release);
            HOOK_STARTING.store(false, Ordering::Release);

            let mut kb = install(WH_KEYBOARD_LL, Some(keyboard_proc));
            let mut ms = install(WH_MOUSE_LL, Some(mouse_proc));

            let mut msg = MSG::default();
            loop {
                let r = GetMessageW(&mut msg, None, 0, 0);
                if r.0 <= 0 {
                    break; // 0 = WM_QUIT, -1 = error; either way stop (never spin)
                }
                if msg.message == WM_PTT_REHOOK {
                    if let Some(h) = kb.take() {
                        let _ = UnhookWindowsHookEx(h);
                    }
                    if let Some(h) = ms.take() {
                        let _ = UnhookWindowsHookEx(h);
                    }
                    kb = install(WH_KEYBOARD_LL, Some(keyboard_proc));
                    ms = install(WH_MOUSE_LL, Some(mouse_proc));
                }
                // No dispatch needed -the hooks fire on this thread directly.
            }

            // Leaving the loop means the hooks are about to die with the thread;
            // publish that so the watchdog can start a replacement.
            HOOK_THREAD_ID.store(0, Ordering::Release);
            if let Some(h) = kb {
                let _ = UnhookWindowsHookEx(h);
            }
            if let Some(h) = ms {
                let _ = UnhookWindowsHookEx(h);
            }
        });
    }

    unsafe fn install(
        id: windows::Win32::UI::WindowsAndMessaging::WINDOWS_HOOK_ID,
        proc: windows::Win32::UI::WindowsAndMessaging::HOOKPROC,
    ) -> Option<HHOOK> {
        SetWindowsHookExW(id, proc, None, 0).ok()
    }

    // ── Hook procedures ─────────────────────────────────────────────────────
    //
    // Wait-free and allocation-free by construction; see the module docs. The
    // `catch_unwind` guards exist because unwinding out of `extern "system"`
    // aborts the process from the raw-input path.

    unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        HOOK_CALLS.fetch_add(1, Ordering::Relaxed);
        if code >= 0 {
            let swallow = catch_unwind(AssertUnwindSafe(|| {
                let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
                let msg = wparam.0 as u32;
                let is_down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
                let is_up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
                handle_key(kb.vkCode, is_down, is_up)
            }))
            .unwrap_or(false);
            // While capturing, keys are consumed here and must NOT reach any
            // other window (otherwise Esc closes dialogs, letters type into
            // inputs, etc.).
            if swallow {
                return LRESULT(1);
            }
        }
        CallNextHookEx(HHOOK::default(), code, wparam, lparam)
    }

    unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        HOOK_CALLS.fetch_add(1, Ordering::Relaxed);
        if code >= 0 {
            let swallow = catch_unwind(AssertUnwindSafe(|| {
                let msg = wparam.0 as u32;
                // Bail before touching anything else for moves/wheel/left/right,
                // which are the overwhelming majority of callbacks.
                let is_down = match msg {
                    WM_XBUTTONDOWN | WM_MBUTTONDOWN => true,
                    WM_XBUTTONUP | WM_MBUTTONUP => false,
                    _ => return false,
                };
                let ms = &*(lparam.0 as *const MSLLHOOKSTRUCT);
                let main = match msg {
                    WM_XBUTTONDOWN | WM_XBUTTONUP => {
                        match ((ms.mouseData >> 16) & 0xFFFF) as u16 {
                            XBUTTON1 => Main::MouseX1,
                            XBUTTON2 => Main::MouseX2,
                            _ => return false,
                        }
                    }
                    _ => Main::MouseMid,
                };
                handle_mouse(main, is_down)
            }))
            .unwrap_or(false);
            if swallow {
                return LRESULT(1);
            }
        }
        CallNextHookEx(HHOOK::default(), code, wparam, lparam)
    }

    /// Cached "is the foreground window ours?". `GetForegroundWindow` is a cheap
    /// shared-state read; the pid lookup behind it is not, so it only runs when
    /// the window actually changed.
    unsafe fn foreground_is_self() -> bool {
        let hwnd = GetForegroundWindow();
        let key = hwnd.0 as usize;
        if key == 0 {
            return false;
        }
        if FG_HWND.load(Ordering::Relaxed) == key {
            return FG_SELF.load(Ordering::Relaxed);
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let is_self = pid != 0 && pid == GetCurrentProcessId();
        FG_SELF.store(is_self, Ordering::Relaxed);
        FG_HWND.store(key, Ordering::Relaxed);
        is_self
    }

    // ── Event handling ──────────────────────────────────────────────────────

    /// Handles a keyboard transition. Returns true if the event should be
    /// swallowed (i.e. we are capturing a new binding and must not let the key
    /// reach any app).
    fn handle_key(vk: u32, is_down: bool, is_up: bool) -> bool {
        let modk = is_modifier_vk(vk);

        if CAPTURING.load(Ordering::Acquire) {
            capture_key(vk, modk, is_down, is_up);
            return true;
        }

        for slot in 0..SLOT_COUNT {
            if !ARMED[slot].load(Ordering::Relaxed) {
                continue;
            }
            let Some(b) = binding_now(slot) else { continue };
            let matched_main = match b.main {
                Main::Key(k) => k == vk,
                Main::Modifier(m) => modk == Some(m),
                _ => false,
            };
            if matched_main {
                edge(slot, &b, is_down, is_up);
            }
        }
        false
    }

    /// Handles a mouse-button transition. Returns true if the event should be
    /// swallowed.
    ///
    /// Presses and releases are swallowed *as a pair*: whatever we decide for the
    /// press is recorded and replayed for the release. Deciding per-transition
    /// (as the foreground check alone did) means alt-tabbing mid-click leaks a
    /// press without its release, and the app that got the press keeps the button
    /// down forever.
    fn handle_mouse(main: Main, is_down: bool) -> bool {
        let ate = match main {
            Main::MouseX1 => &ATE_X1,
            Main::MouseX2 => &ATE_X2,
            _ => &ATE_MID,
        };

        if !is_down {
            // Always process the release, even when we hide it from other apps.
            for slot in 0..SLOT_COUNT {
                if ARMED[slot].load(Ordering::Relaxed) {
                    if let Some(b) = binding_now(slot) {
                        if b.main == main {
                            edge(slot, &b, false, true);
                        }
                    }
                }
            }
            return ate.swap(false, Ordering::Relaxed);
        }

        let mut swallow = false;
        if CAPTURING.load(Ordering::Acquire) {
            let (c, a, sh, w) = mods_now();
            let slot = CAPTURE_SLOT.load(Ordering::Relaxed) as usize;
            finish_capture(slot, Binding { ctrl: c, alt: a, shift: sh, win: w, main });
            swallow = true; // don't let the click being bound also act
        } else {
            for slot in 0..SLOT_COUNT {
                if ARMED[slot].load(Ordering::Relaxed) {
                    if let Some(b) = binding_now(slot) {
                        if b.main == main {
                            edge(slot, &b, true, false);
                        }
                    }
                }
            }
            // Swallow the mouse back/forward buttons while OUR window is focused,
            // so WebView2 doesn't perform history navigation. When the game is
            // focused we pass them through (so the game -and PTT bound to them
            // -still works).
            if matches!(main, Main::MouseX1 | Main::MouseX2) && unsafe { foreground_is_self() } {
                swallow = true;
            }
        }
        ate.store(swallow, Ordering::Relaxed);
        swallow
    }

    /// Builds a binding from captured input. `capture_combo_used` from the old
    /// mutex-based version is gone: a non-modifier press finalises immediately,
    /// so a modifier release can only be seen while the candidate is still the
    /// only thing held.
    fn capture_key(vk: u32, modk: Option<ModKey>, is_down: bool, is_up: bool) {
        // Escape cancels the capture instead of binding to it.
        if is_down && vk == 0x1B {
            let slot = CAPTURE_SLOT.load(Ordering::Relaxed);
            end_capture();
            emit_event(EV_CAPTURE_CANCEL, slot as u64);
            return;
        }
        let slot = CAPTURE_SLOT.load(Ordering::Relaxed) as usize;
        match modk {
            // A non-modifier key press finalises as Key + whatever mods are held.
            None if is_down => {
                let (c, a, sh, w) = mods_now();
                finish_capture(slot, Binding { ctrl: c, alt: a, shift: sh, win: w, main: Main::Key(vk) });
            }
            // Modifier down: remember it as a bare-modifier candidate.
            Some(m) if is_down => CAPTURE_MOD.store(mod_code(m), Ordering::Relaxed),
            // Modifier up with nothing else pressed during the hold → bare modifier.
            Some(m) if is_up => {
                if CAPTURE_MOD.load(Ordering::Relaxed) == mod_code(m) {
                    finish_capture(slot, Binding {
                        ctrl: false,
                        alt: false,
                        shift: false,
                        win: false,
                        main: Main::Modifier(m),
                    });
                }
            }
            _ => {}
        }
    }

    /// Stores a finalised capture and notifies the frontend. Token/label are
    /// formatted on the worker thread so no string work happens in a hook.
    fn finish_capture(slot: usize, binding: Binding) {
        let packed = pack(&binding);
        end_capture();
        BINDING[slot].store(packed, Ordering::Relaxed);
        PRESSED[slot].store(false, Ordering::Relaxed);
        emit_event(EV_CAPTURE, (packed << 8) | slot as u64);
    }

    /// Computes and emits the down/up edge for a matched main input.
    fn edge(slot: usize, b: &Binding, is_down: bool, is_up: bool) {
        if is_down {
            // Required modifiers must be held (extras are ignored).
            let (c, a, sh, w) = mods_now();
            let mods_ok = (!b.ctrl || c) && (!b.alt || a) && (!b.shift || sh) && (!b.win || w);
            // The swap is the de-dup: only the thread that flips false→true emits.
            if mods_ok && !PRESSED[slot].swap(true, Ordering::AcqRel) {
                emit_event(EV_DOWN, slot as u64);
            }
        } else if is_up && PRESSED[slot].swap(false, Ordering::AcqRel) {
            emit_event(EV_UP, slot as u64);
        }
    }

    // ── Token / label serialisation ──────────────────────────────────────────

    fn token_of(b: &Binding) -> String {
        if let Main::Modifier(m) = b.main {
            return mod_name(m).to_string();
        }
        let mut parts: Vec<String> = Vec::new();
        if b.ctrl {
            parts.push("Ctrl".into());
        }
        if b.alt {
            parts.push("Alt".into());
        }
        if b.shift {
            parts.push("Shift".into());
        }
        if b.win {
            parts.push("Win".into());
        }
        parts.push(match b.main {
            Main::Key(k) => format!("VK{k}"),
            Main::MouseX1 => "MouseX1".into(),
            Main::MouseX2 => "MouseX2".into(),
            Main::MouseMid => "MouseMid".into(),
            Main::Modifier(_) => unreachable!(),
        });
        parts.join("+")
    }

    fn format_binding(b: &Binding) -> String {
        if let Main::Modifier(m) = b.main {
            return mod_label(m).to_string();
        }
        let mut parts: Vec<String> = Vec::new();
        if b.ctrl {
            parts.push("Ctrl".into());
        }
        if b.alt {
            parts.push("Alt".into());
        }
        if b.shift {
            parts.push("Shift".into());
        }
        if b.win {
            parts.push("Win".into());
        }
        parts.push(match b.main {
            Main::Key(k) => vk_label(k),
            Main::MouseX1 => "Mouse 4".into(),
            Main::MouseX2 => "Mouse 5".into(),
            Main::MouseMid => "Middle Mouse".into(),
            Main::Modifier(_) => unreachable!(),
        });
        parts.join(" + ")
    }

    fn parse_token(token: &str) -> Option<Binding> {
        let token = token.trim();
        if token.is_empty() {
            return None;
        }

        let mut ctrl = false;
        let mut alt = false;
        let mut shift = false;
        let mut win = false;
        let mut main: Option<Main> = None;

        for raw in token.split('+') {
            let part = raw.trim();
            match part {
                "Ctrl" | "Control" => ctrl = true,
                "Alt" => alt = true,
                "Shift" => shift = true,
                "Win" | "Super" | "Meta" => win = true,
                "MouseX1" => main = Some(Main::MouseX1),
                "MouseX2" => main = Some(Main::MouseX2),
                "MouseMid" => main = Some(Main::MouseMid),
                _ => {
                    if let Some(rest) = part.strip_prefix("VK") {
                        main = Some(Main::Key(rest.parse().ok()?));
                    } else if let Some(vk) = code_name_to_vk(part) {
                        main = Some(Main::Key(vk));
                    } else {
                        return None;
                    }
                }
            }
        }

        match main {
            Some(m) => Some(Binding { ctrl, alt, shift, win, main: m }),
            None => {
                // No explicit main: a single bare modifier is a valid binding.
                let count = [ctrl, alt, shift, win].iter().filter(|x| **x).count();
                if count == 1 {
                    let m = if ctrl {
                        ModKey::Ctrl
                    } else if alt {
                        ModKey::Alt
                    } else if shift {
                        ModKey::Shift
                    } else {
                        ModKey::Win
                    };
                    Some(Binding { ctrl: false, alt: false, shift: false, win: false, main: Main::Modifier(m) })
                } else {
                    None
                }
            }
        }
    }

    fn mod_name(m: ModKey) -> &'static str {
        match m {
            ModKey::Ctrl => "Ctrl",
            ModKey::Alt => "Alt",
            ModKey::Shift => "Shift",
            ModKey::Win => "Win",
        }
    }

    fn mod_label(m: ModKey) -> &'static str {
        match m {
            ModKey::Ctrl => "Ctrl",
            ModKey::Alt => "Alt",
            ModKey::Shift => "Shift",
            ModKey::Win => "Win",
        }
    }

    fn vk_label(vk: u32) -> String {
        match vk {
            0x30..=0x39 => ((b'0' + (vk - 0x30) as u8) as char).to_string(),
            0x41..=0x5A => ((b'A' + (vk - 0x41) as u8) as char).to_string(),
            0x70..=0x87 => format!("F{}", vk - 0x6F),
            0x20 => "Space".into(),
            0xC0 => "`".into(),
            0x09 => "Tab".into(),
            0x14 => "Caps Lock".into(),
            _ => format!("Key {vk}"),
        }
    }

    /// Maps a JS `KeyboardEvent.code` (used by the global-shortcut fallback and the
    /// legacy default) to a Windows virtual-key, so tokens stay portable.
    fn code_name_to_vk(code: &str) -> Option<u32> {
        if let Some(letter) = code.strip_prefix("Key") {
            let c = letter.chars().next()?;
            if c.is_ascii_uppercase() {
                return Some(c as u32);
            }
        }
        if let Some(digit) = code.strip_prefix("Digit") {
            let c = digit.chars().next()?;
            if c.is_ascii_digit() {
                return Some(c as u32);
            }
        }
        if let Some(n) = code.strip_prefix('F') {
            if let Ok(num) = n.parse::<u32>() {
                if (1..=24).contains(&num) {
                    return Some(0x6F + num);
                }
            }
        }
        match code {
            "Backquote" => Some(0xC0),
            "Space" => Some(0x20),
            "Tab" => Some(0x09),
            _ => None,
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    use tauri::AppHandle;

    pub fn supported() -> bool {
        false
    }

    pub fn init(_app: &AppHandle) {}

    pub fn set_binding(_slot: u8, _token: String) -> Result<(), String> {
        Err("native push-to-talk is only supported on Windows".into())
    }

    pub fn arm(_slot: u8) -> Result<(), String> {
        Err("unsupported".into())
    }

    pub fn disarm(_slot: u8) -> Result<(), String> {
        Ok(())
    }

    pub fn begin_capture(_slot: u8) -> Result<(), String> {
        Err("unsupported".into())
    }

    pub fn cancel_capture() -> Result<(), String> {
        Ok(())
    }

    pub fn label(token: String) -> String {
        token
    }
}

/// Store the AppHandle and install the hooks (Windows only). Called once at setup.
pub fn init(app: &tauri::AppHandle) {
    imp::init(app);
}

#[tauri::command]
pub fn ptt_supported() -> bool {
    imp::supported()
}

#[tauri::command]
pub fn ptt_set_binding(slot: u8, token: String) -> Result<(), String> {
    imp::set_binding(slot, token)
}

#[tauri::command]
pub fn ptt_arm(slot: u8) -> Result<(), String> {
    imp::arm(slot)
}

#[tauri::command]
pub fn ptt_disarm(slot: u8) -> Result<(), String> {
    imp::disarm(slot)
}

#[tauri::command]
pub fn ptt_begin_capture(slot: u8) -> Result<(), String> {
    imp::begin_capture(slot)
}

#[tauri::command]
pub fn ptt_cancel_capture() -> Result<(), String> {
    imp::cancel_capture()
}

#[tauri::command]
pub fn ptt_label(token: String) -> String {
    imp::label(token)
}
