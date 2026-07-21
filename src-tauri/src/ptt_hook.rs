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
//! Binding token format (stored in settings, `+`-joined):
//!   modifiers: `Ctrl` `Alt` `Shift` `Win`
//!   main:      `VK<code>` (virtual-key), `MouseX1` `MouseX2` `MouseMid`,
//!              or -for a bare modifier -just the single modifier name.
//!   examples:  `Ctrl+VK86` (Ctrl+V), `VK118` (F7), `MouseX2`, `Ctrl`

#[cfg(target_os = "windows")]
mod imp {
    use std::sync::{Mutex, OnceLock};
    use std::thread;

    use serde::Serialize;
    use tauri::{AppHandle, Emitter};

    use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::Threading::GetCurrentProcessId;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, GetForegroundWindow, GetMessageW, GetWindowThreadProcessId,
        SetWindowsHookExW, HHOOK, KBDLLHOOKSTRUCT, MSG, MSLLHOOKSTRUCT, WH_KEYBOARD_LL,
        WH_MOUSE_LL, WM_KEYDOWN, WM_KEYUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_SYSKEYDOWN,
        WM_SYSKEYUP, WM_XBUTTONDOWN, WM_XBUTTONUP,
    };

    const XBUTTON1: u16 = 0x0001;
    const XBUTTON2: u16 = 0x0002;

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

    struct State {
        app: Option<AppHandle>,
        armed: bool,
        pressed: bool,
        capturing: bool,
        capture_mod: Option<ModKey>,
        capture_combo_used: bool,
        binding: Option<Binding>,
    }

    #[derive(Serialize, Clone)]
    struct CaptureResult {
        token: String,
        label: String,
        cancelled: bool,
    }

    static STATE: OnceLock<Mutex<State>> = OnceLock::new();

    fn state() -> &'static Mutex<State> {
        STATE.get_or_init(|| {
            Mutex::new(State {
                app: None,
                armed: false,
                pressed: false,
                capturing: false,
                capture_mod: None,
                capture_combo_used: false,
                binding: None,
            })
        })
    }

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

    fn emit(app: &AppHandle, event: &str) {
        let _ = app.emit(event, ());
    }

    // ── Public surface (called from the Tauri commands) ─────────────────────

    pub fn supported() -> bool {
        true
    }

    pub fn init(app: &AppHandle) {
        {
            let mut s = state().lock().unwrap();
            if s.app.is_some() {
                return; // already initialised
            }
            s.app = Some(app.clone());
        }
        // Low-level hooks must be installed on a thread that pumps messages.
        thread::spawn(|| unsafe {
            let _kb = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), None, 0);
            let _ms = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), None, 0);
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).as_bool() {
                // No dispatch needed -the hooks fire on this thread directly.
            }
        });
    }

    pub fn set_binding(token: String) -> Result<(), String> {
        let binding = parse_token(&token).ok_or_else(|| format!("invalid binding: {token}"))?;
        let mut s = state().lock().unwrap();
        s.binding = Some(binding);
        s.pressed = false;
        Ok(())
    }

    pub fn arm() -> Result<(), String> {
        let mut s = state().lock().unwrap();
        if s.binding.is_none() {
            return Err("no binding set".into());
        }
        s.armed = true;
        s.pressed = false;
        Ok(())
    }

    pub fn disarm() -> Result<(), String> {
        let (app, was_pressed) = {
            let mut s = state().lock().unwrap();
            s.armed = false;
            let was = s.pressed;
            s.pressed = false;
            (s.app.clone(), was)
        };
        if was_pressed {
            if let Some(app) = app {
                emit(&app, "ptt-up");
            }
        }
        Ok(())
    }

    pub fn begin_capture() -> Result<(), String> {
        let mut s = state().lock().unwrap();
        s.capturing = true;
        s.capture_mod = None;
        s.capture_combo_used = false;
        Ok(())
    }

    pub fn cancel_capture() -> Result<(), String> {
        let app = {
            let mut s = state().lock().unwrap();
            s.capturing = false;
            s.capture_mod = None;
            s.app.clone()
        };
        if let Some(app) = app {
            let _ = app.emit(
                "ptt-capture",
                CaptureResult { token: String::new(), label: String::new(), cancelled: true },
            );
        }
        Ok(())
    }

    pub fn label(token: String) -> String {
        match parse_token(&token) {
            Some(b) => format_binding(&b),
            None => token,
        }
    }

    // ── Hook procedures ──────────────────────────────────────────────────────

    unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
            let msg = wparam.0 as u32;
            let is_down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
            let is_up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
            handle_key(kb.vkCode, is_down, is_up);
        }
        CallNextHookEx(HHOOK::default(), code, wparam, lparam)
    }

    unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 {
            let ms = &*(lparam.0 as *const MSLLHOOKSTRUCT);
            let msg = wparam.0 as u32;
            let xbtn = ((ms.mouseData >> 16) & 0xFFFF) as u16;
            let main = match msg {
                WM_XBUTTONDOWN | WM_XBUTTONUP => {
                    if xbtn == XBUTTON1 {
                        Some(Main::MouseX1)
                    } else if xbtn == XBUTTON2 {
                        Some(Main::MouseX2)
                    } else {
                        None
                    }
                }
                WM_MBUTTONDOWN | WM_MBUTTONUP => Some(Main::MouseMid),
                _ => None,
            };
            if let Some(main) = main {
                let is_down = msg == WM_XBUTTONDOWN || msg == WM_MBUTTONDOWN;
                handle_mouse(main, is_down);
            }

            // Swallow the mouse back/forward buttons while OUR window is focused, so
            // WebView2 doesn't perform history navigation. When the game is focused we
            // pass them through (so the game -and PTT bound to them -still works).
            if (msg == WM_XBUTTONDOWN || msg == WM_XBUTTONUP) && foreground_is_self() {
                return LRESULT(1);
            }
        }
        CallNextHookEx(HHOOK::default(), code, wparam, lparam)
    }

    unsafe fn foreground_is_self() -> bool {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return false;
        }
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        pid != 0 && pid == GetCurrentProcessId()
    }

    // ── Event handling ─────────────────────────────────────────────────────

    fn handle_key(vk: u32, is_down: bool, is_up: bool) {
        let modk = is_modifier_vk(vk);

        // Capture mode: build a new binding from the next input.
        let capture_action = {
            let mut s = state().lock().unwrap();
            if s.capturing {
                capture_key(&mut s, vk, modk, is_down, is_up)
            } else {
                CaptureAction::None
            }
        };
        if finalize(capture_action) {
            return;
        }

        // Armed matching.
        let (down, up) = {
            let mut s = state().lock().unwrap();
            if !s.armed {
                return;
            }
            let Some(b) = s.binding else { return };
            let matched_main = match b.main {
                Main::Key(k) => k == vk,
                Main::Modifier(m) => modk == Some(m),
                _ => false,
            };
            if !matched_main {
                return;
            }
            let (down, up) = edge(&mut s, &b, is_down, is_up);
            (down, up)
        };
        emit_edges(down, up);
    }

    fn handle_mouse(main: Main, is_down: bool) {
        let capture_action = {
            let mut s = state().lock().unwrap();
            if s.capturing && is_down {
                let (c, a, sh, w) = mods_now();
                let binding = Binding { ctrl: c, alt: a, shift: sh, win: w, main };
                s.capturing = false;
                s.capture_mod = None;
                CaptureAction::Finalize(binding)
            } else {
                CaptureAction::None
            }
        };
        if finalize(capture_action) {
            return;
        }

        let (down, up) = {
            let mut s = state().lock().unwrap();
            if !s.armed {
                return;
            }
            let Some(b) = s.binding else { return };
            if b.main != main {
                return;
            }
            edge(&mut s, &b, is_down, !is_down)
        };
        emit_edges(down, up);
    }

    enum CaptureAction {
        None,
        Finalize(Binding),
        Cancel,
    }

    /// Returns a capture action; must be called while holding the state lock.
    fn capture_key(
        s: &mut State,
        vk: u32,
        modk: Option<ModKey>,
        is_down: bool,
        is_up: bool,
    ) -> CaptureAction {
        // Escape cancels the capture instead of binding to it.
        if is_down && vk == 0x1B {
            s.capturing = false;
            s.capture_mod = None;
            return CaptureAction::Cancel;
        }
        match modk {
            // A non-modifier key press finalises as Key + whatever mods are held.
            None if is_down => {
                let (c, a, sh, w) = mods_now();
                s.capturing = false;
                s.capture_mod = None;
                CaptureAction::Finalize(Binding { ctrl: c, alt: a, shift: sh, win: w, main: Main::Key(vk) })
            }
            // Modifier down: remember it as a bare-modifier candidate.
            Some(m) if is_down => {
                s.capture_mod = Some(m);
                s.capture_combo_used = false;
                CaptureAction::None
            }
            // Modifier up with no other key pressed during the hold → bare modifier.
            Some(m) if is_up => {
                if s.capture_mod == Some(m) && !s.capture_combo_used {
                    s.capturing = false;
                    s.capture_mod = None;
                    CaptureAction::Finalize(Binding {
                        ctrl: false,
                        alt: false,
                        shift: false,
                        win: false,
                        main: Main::Modifier(m),
                    })
                } else {
                    CaptureAction::None
                }
            }
            _ => CaptureAction::None,
        }
    }

    /// Applies a finalised capture (store + emit). Returns true if it consumed the event.
    fn finalize(action: CaptureAction) -> bool {
        match action {
            CaptureAction::None => false,
            CaptureAction::Cancel => {
                let app = state().lock().unwrap().app.clone();
                if let Some(app) = app {
                    let _ = app.emit(
                        "ptt-capture",
                        CaptureResult { token: String::new(), label: String::new(), cancelled: true },
                    );
                }
                true
            }
            CaptureAction::Finalize(binding) => {
                let (app, token, label) = {
                    let mut s = state().lock().unwrap();
                    s.binding = Some(binding);
                    s.pressed = false;
                    (s.app.clone(), token_of(&binding), format_binding(&binding))
                };
                if let Some(app) = app {
                    let _ = app.emit("ptt-capture", CaptureResult { token, label, cancelled: false });
                }
                true
            }
        }
    }

    /// Computes down/up edges for a matched main input. Holds the state lock.
    fn edge(s: &mut State, b: &Binding, is_down: bool, is_up: bool) -> (bool, bool) {
        if is_down {
            // Required modifiers must be held (extras are ignored).
            let (c, a, sh, w) = mods_now();
            let mods_ok = (!b.ctrl || c) && (!b.alt || a) && (!b.shift || sh) && (!b.win || w);
            if mods_ok && !s.pressed {
                s.pressed = true;
                return (true, false);
            }
        } else if is_up && s.pressed {
            s.pressed = false;
            return (false, true);
        }
        (false, false)
    }

    fn emit_edges(down: bool, up: bool) {
        if !down && !up {
            return;
        }
        let app = state().lock().unwrap().app.clone();
        if let Some(app) = app {
            if down {
                emit(&app, "ptt-down");
            }
            if up {
                emit(&app, "ptt-up");
            }
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

    pub fn set_binding(_token: String) -> Result<(), String> {
        Err("native push-to-talk is only supported on Windows".into())
    }

    pub fn arm() -> Result<(), String> {
        Err("unsupported".into())
    }

    pub fn disarm() -> Result<(), String> {
        Ok(())
    }

    pub fn begin_capture() -> Result<(), String> {
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
pub fn ptt_set_binding(token: String) -> Result<(), String> {
    imp::set_binding(token)
}

#[tauri::command]
pub fn ptt_arm() -> Result<(), String> {
    imp::arm()
}

#[tauri::command]
pub fn ptt_disarm() -> Result<(), String> {
    imp::disarm()
}

#[tauri::command]
pub fn ptt_begin_capture() -> Result<(), String> {
    imp::begin_capture()
}

#[tauri::command]
pub fn ptt_cancel_capture() -> Result<(), String> {
    imp::cancel_capture()
}

#[tauri::command]
pub fn ptt_label(token: String) -> String {
    imp::label(token)
}
