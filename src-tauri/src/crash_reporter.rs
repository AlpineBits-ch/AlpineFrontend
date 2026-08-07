//! Turns an access violation into a line naming the module and the stack it came from.
//!
//! The one fact that separates "our bug" from "a driver fell over" is which module faulted, and a
//! process that dies on `0xC0000005` carries none of it - the exit code is identical either way.
//! That cost a long investigation once: a screen share crashed on changing resolution with nothing
//! to go on but our own code, and the answer was four frames deep inside a vendor DLL, on a thread
//! the client does not own and never created.
//!
//! Compiled into release builds on purpose. The output goes to stderr, which [`crate::logging`]
//! tees into the log file, so the next one arrives already attributed.

use std::sync::OnceLock;

use windows::core::PCWSTR;
use windows::Win32::System::Diagnostics::Debug::{
    AddVectoredExceptionHandler, RtlCaptureStackBackTrace, EXCEPTION_POINTERS,
};
use windows::Win32::System::LibraryLoader::{
    GetModuleFileNameW, GetModuleHandleExW, GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
    GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
};
use windows::Win32::System::Threading::GetCurrentThreadId;

/// Continue the search, so the process still dies exactly as it would have.
const EXCEPTION_CONTINUE_SEARCH: i32 = 0;
const ACCESS_VIOLATION: i32 = 0xC000_0005u32 as i32;

/// How far up the stack to report. Deep enough to cross from a worker thread's entry point through
/// whatever queued the work into the code that faulted, which is where the answer usually is.
const FRAMES: usize = 24;

static INSTALLED: OnceLock<()> = OnceLock::new();

/// Idempotent, so it can be called from process startup and again from anything that runs before
/// it - the tests never go through `run()`, and a handler installed too late reports nothing.
pub fn install() {
    INSTALLED.get_or_init(|| unsafe {
        AddVectoredExceptionHandler(1, Some(on_exception));
    });
}

unsafe extern "system" fn on_exception(info: *mut EXCEPTION_POINTERS) -> i32 {
    let Some(info) = info.as_ref() else {
        return EXCEPTION_CONTINUE_SEARCH;
    };
    let Some(record) = info.ExceptionRecord.as_ref() else {
        return EXCEPTION_CONTINUE_SEARCH;
    };
    // First-chance exceptions include plenty that are handled and harmless - C++ unwinds, debugger
    // notifications. Only the one that kills processes is worth a line.
    if record.ExceptionCode.0 != ACCESS_VIOLATION {
        return EXCEPTION_CONTINUE_SEARCH;
    }

    let address = record.ExceptionAddress as usize;
    eprintln!(
        "[crash] access violation at {address:#x} in {} on OS thread {}",
        module_for(address),
        GetCurrentThreadId(),
    );

    if record.NumberParameters >= 2 {
        let operation = match record.ExceptionInformation[0] {
            0 => "read",
            1 => "write",
            8 => "execute",
            _ => "access",
        };
        eprintln!("[crash] {operation} of {:#x}", record.ExceptionInformation[1]);
    }

    // The module names down the stack are the diagnosis. A fault inside a driver's own worker
    // thread and one we reached from our own code look identical without them.
    let mut frames = [std::ptr::null_mut::<core::ffi::c_void>(); FRAMES];
    let captured = RtlCaptureStackBackTrace(0, &mut frames, None) as usize;
    for (depth, frame) in frames[..captured].iter().enumerate() {
        let addr = *frame as usize;
        eprintln!("[crash]   #{depth:<2} {addr:#018x}  {}", module_for(addr));
    }

    EXCEPTION_CONTINUE_SEARCH
}

fn module_for(address: usize) -> String {
    unsafe {
        let mut module = Default::default();
        if GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            PCWSTR(address as *const u16),
            &mut module,
        )
        .is_err()
        {
            // No module owns the address: freed code, a corrupted return address, or a JIT page.
            // Worth saying rather than leaving blank - it is itself a strong hint.
            return "<no module>".to_owned();
        }
        let mut buffer = [0u16; 260];
        let len = GetModuleFileNameW(module, &mut buffer) as usize;
        String::from_utf16_lossy(&buffer[..len])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installing_twice_is_harmless() {
        // Called from `run()` and again from the Media Foundation path, in either order.
        install();
        install();
    }

    #[test]
    fn an_address_inside_this_binary_resolves_to_this_binary() {
        // Through a fn pointer: casting a function *item* straight to an integer is a different
        // thing and clippy is right to flag it.
        let here = module_for(module_for as fn(usize) -> String as usize);
        assert!(
            here.to_ascii_lowercase().contains(".exe"),
            "expected this test binary, got {here}"
        );
    }

    #[test]
    fn an_unmapped_address_is_reported_rather_than_guessed() {
        assert_eq!(module_for(0x24), "<no module>");
    }
}
