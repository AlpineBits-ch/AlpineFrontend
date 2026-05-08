//! Process-excluded WASAPI loopback capture (Windows 10 2004+ / build 19041+).
//!
//! Uses `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` with
//! `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` to capture all system
//! audio *except* what is played back by the current process tree (Alpine +
//! WebView2 child processes).  This prevents the remote participants' voices,
//! which WebView2 plays through the system output, from being looped back and
//! heard as an echo by the screen-share recipient.

use super::audio::{base64_encode, resample_linear, AudioChunk, BATCH_SAMPLES};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use tauri::ipc::Channel;
use windows::{
    core::{implement, AgileReference, Error, Interface, Result, HRESULT, PROPVARIANT},
    Win32::{
        Foundation::{CloseHandle, E_FAIL, E_OUTOFMEMORY},
        Media::Audio::{
            ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
            IActivateAudioInterfaceCompletionHandler,
            IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient,
            AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
            AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
            PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        },
        Security::SECURITY_ATTRIBUTES,
        System::{
            Com::{CoIncrementMTAUsage, CoTaskMemAlloc, CoTaskMemFree},
            Threading::{CreateEventW, WaitForSingleObject},
            Variant::VT_BLOB,
        },
    },
};

// ── MTA lifetime management ───────────────────────────────────────────────────
//
// Root cause of STATUS_HEAP_CORRUPTION:
//   - cpal initialises COM as STA on Windows (confirmed in RustAudio/cpal#597).
//   - Previous code called CoInitializeEx(COINIT_MULTITHREADED) on the capture
//     thread and CoUninitialize on exit.
//   - CoUninitialize can drop the last MTA reference for the process, which
//     causes Windows to unload all COM DLLs — including the WGC runtime that
//     xcap still has live pointers into. Next WGC call = heap corruption.
//
// Fix: call CoIncrementMTAUsage once and never decrement it.
//   - Keeps the MTA alive for the process lifetime regardless of what cpal does.
//   - Every thread is implicitly in the MTA, so no CoInitializeEx needed.
//   - CoUninitialize on any thread can never be the last reference.
//   - Same fix used by Mozilla cubeb / Firefox for the identical crash.
//
// CoIncrementMTAUsage returns the cookie by value in windows-rs 0.58+.
// We intentionally leak it (stored in OnceLock, never dropped).
static MTA_ALIVE: OnceLock<()> = OnceLock::new();

fn ensure_mta_alive() -> Result<()> {
    if MTA_ALIVE.get().is_some() {
        return Ok(());
    }
    // Safety: CoIncrementMTAUsage is safe to call from any thread at any time.
    // The returned CO_MTA_USAGE_COOKIE is intentionally discarded — we never
    // want to call CoDecrementMTAUsage, so leaking it is correct.
    unsafe { CoIncrementMTAUsage() }?;
    // If two threads race here both called CoIncrementMTAUsage — harmless,
    // the MTA just has an extra permanent reference.
    let _ = MTA_ALIVE.set(());
    Ok(())
}

// ── AgileReference wrapper ────────────────────────────────────────────────────

// AgileReference is COM-apartment-agnostic: it can be sent across threads and
// resolved to a live interface pointer in any apartment. Replaces the previous
// raw-pointer approach (bare usize) that caused heap corruption when the pointer
// was reconstructed in a different COM apartment.
struct AgileClient(AgileReference<IAudioClient>);
// Safety: AgileReference<T> is itself Send — it holds an IGlobalInterfaceTable
// cookie kept alive by the OS until we resolve or drop it.
unsafe impl Send for AgileClient {}

// ── Completion handler ────────────────────────────────────────────────────────

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct CompletionHandler {
    tx: Mutex<Option<std::sync::mpsc::SyncSender<Result<AgileClient>>>>,
}

impl IActivateAudioInterfaceCompletionHandler_Impl for CompletionHandler_Impl {
    fn ActivateCompleted(&self, op: Option<&IActivateAudioInterfaceAsyncOperation>) -> Result<()> {
        let send = self.tx.lock().unwrap().take();
        let result = (|| -> Result<AgileClient> {
            let op = op.ok_or_else(|| Error::from(E_FAIL))?;
            let mut hr = HRESULT(0);
            let mut punk: Option<windows::core::IUnknown> = None;
            // Safety: op is a valid IActivateAudioInterfaceAsyncOperation provided by the OS.
            unsafe { op.GetActivateResult(&mut hr, &mut punk)? };
            hr.ok()?;
            let client: IAudioClient = punk.ok_or_else(|| Error::from(E_FAIL))?.cast()?;
            // Wrap in AgileReference so it can cross apartment boundaries safely.
            let agile = AgileReference::new(&client)?;
            Ok(AgileClient(agile))
        })();
        if let Some(tx) = send {
            let _ = tx.send(result);
        }
        Ok(())
    }
}

// ── Public capture entry point ────────────────────────────────────────────────

/// Captures all system audio except this process tree and sends `AudioChunk`
/// messages via `on_chunk` until `stop` is set.
///
/// Returns `Err` if process-excluded activation is unsupported (pre-2004
/// Windows) or if the mix format is not 32-bit float — the caller should
/// fall back to the device-loopback path.
pub fn capture_excluded(on_chunk: Channel<AudioChunk>, stop: Arc<AtomicBool>) -> Result<()> {
    // Pin the MTA before touching any COM/WASAPI/WGC API.
    ensure_mta_alive()?;

    // ── Build activation parameters ───────────────────────────────────────────
    //
    // CRITICAL: pBlobData inside a VT_BLOB PROPVARIANT MUST point to a
    // CoTaskMem-allocated buffer. When ActivateAudioInterfaceAsync completes,
    // COM internally calls PropVariantClear on the PROPVARIANT, which calls
    // CoTaskMemFree on pBlobData. If pBlobData points to the stack (as it did
    // previously), CoTaskMemFree/RtlFreeHeap receives a stack pointer and
    // immediately triggers STATUS_HEAP_CORRUPTION. This was the root cause.
    let pid = std::process::id();

    // Allocate params on the COM heap so PropVariantClear can legally free it.
    // Safety: CoTaskMemAlloc returns a valid pointer or null; we check for null.
    let params_ptr = unsafe {
        use windows::Win32::System::Com::CoTaskMemAlloc;
        let ptr = CoTaskMemAlloc(std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>())
            as *mut AUDIOCLIENT_ACTIVATION_PARAMS;
        if ptr.is_null() {
            return Err(Error::from(windows::Win32::Foundation::E_OUTOFMEMORY));
        }
        ptr.write(AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: pid,
                    ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
                },
            },
        });
        ptr
    };

    let raw_pv = windows_core::imp::PROPVARIANT {
        Anonymous: windows_core::imp::PROPVARIANT_0 {
            Anonymous: windows_core::imp::PROPVARIANT_0_0 {
                vt: VT_BLOB.0,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: windows_core::imp::PROPVARIANT_0_0_0 {
                    blob: windows_core::imp::BLOB {
                        cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                        // pBlobData now points to CoTaskMem heap — PropVariantClear
                        // can safely free this when ActivateAudioInterfaceAsync cleans up.
                        pBlobData: params_ptr as *mut u8,
                    },
                },
            },
        },
    };
    // Safety: repr(transparent) guarantees identical memory layout.
    let pv: PROPVARIANT = unsafe { std::mem::transmute(raw_pv) };

    // ── Activate process-excluded loopback asynchronously ────────────────────
    let (tx, rx) = std::sync::mpsc::sync_channel::<Result<AgileClient>>(1);
    let handler: IActivateAudioInterfaceCompletionHandler = CompletionHandler {
        tx: Mutex::new(Some(tx)),
    }
    .into();

    // Safety: handler is alive until rx.recv() returns, which blocks until
    // ActivateCompleted fires on the COM callback thread.
    unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&pv),
            &handler,
        )?;
    }

    // Block until the COM callback fires (typically < 1 ms on Win 10 2004+).
    let agile_client = rx.recv().map_err(|_| Error::from(E_FAIL))??;

    // Resolve on this thread — safe because the permanent MTA means every
    // thread is in the MTA, so AgileReference resolves without marshalling overhead.
    let client = agile_client.0.resolve()?;

    // ── Inspect mix format ────────────────────────────────────────────────────
    let (channels, sample_rate, is_float32, fmt) = unsafe {
        let mix_ptr = client.GetMixFormat()?;
        let fmt = *mix_ptr;
        CoTaskMemFree(Some(mix_ptr as *const _ as *const std::ffi::c_void));
        let channels = fmt.nChannels as usize;
        let sample_rate = fmt.nSamplesPerSec;
        let is_float32 = (fmt.wFormatTag == 3 /* WAVE_FORMAT_IEEE_FLOAT */
            || fmt.wFormatTag == 0xFFFE/* WAVE_FORMAT_EXTENSIBLE */)
            && fmt.wBitsPerSample == 32;
        (channels, sample_rate, is_float32, fmt)
    };

    if !is_float32 {
        return Err(Error::from(E_FAIL));
    }

    // ── Initialize client and start capture ───────────────────────────────────
    let (capture, ready_event) = unsafe {
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            200_000, // 20 ms buffer in 100-ns units
            0,
            &fmt,
            None,
        )?;
        let ready_event = CreateEventW(None::<*const SECURITY_ATTRIBUTES>, false, false, None)?;
        client.SetEventHandle(ready_event)?;
        let capture: IAudioCaptureClient = client.GetService()?;
        client.Start()?;
        (capture, ready_event)
    };

    // ── Capture loop ──────────────────────────────────────────────────────────
    let mut mono_buf: Vec<f32> = Vec::with_capacity(BATCH_SAMPLES * 2);

    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }

        // Safety: ready_event is a valid kernel event HANDLE.
        unsafe {
            WaitForSingleObject(ready_event, 10);
        } // 10 ms — lets us check stop flag

        if stop.load(Ordering::Relaxed) {
            break;
        }

        // Drain all ready packets.
        loop {
            let has_data = unsafe { matches!(capture.GetNextPacketSize(), Ok(n) if n > 0) };
            if !has_data {
                break;
            }

            let mut buf_ptr: *mut u8 = std::ptr::null_mut();
            let mut num_frames = 0u32;
            let mut flags = 0u32;

            let ok = unsafe {
                capture
                    .GetBuffer(&mut buf_ptr, &mut num_frames, &mut flags, None, None)
                    .is_ok()
            };
            if !ok || buf_ptr.is_null() || num_frames == 0 {
                // Safety: ReleaseBuffer(0) is a documented no-op on error.
                unsafe {
                    let _ = capture.ReleaseBuffer(0);
                }
                break;
            }

            let n_samples = num_frames as usize * channels;
            // AUDCLNT_BUFFERFLAGS_SILENT = 0x2
            if flags & 0x2 != 0 {
                mono_buf.extend(std::iter::repeat_n(0.0f32, num_frames as usize));
            } else {
                // Safety: buf_ptr points to exactly n_samples IEEE-float32 values;
                // buffer is valid until ReleaseBuffer is called below.
                let interleaved =
                    unsafe { std::slice::from_raw_parts(buf_ptr as *const f32, n_samples) };
                for frame in interleaved.chunks_exact(channels) {
                    let mono = frame.iter().sum::<f32>() / channels as f32;
                    mono_buf.push(mono);
                }
            }
            // Safety: must be called after GetBuffer; num_frames matches GetBuffer.
            unsafe {
                let _ = capture.ReleaseBuffer(num_frames);
            }
        }

        // Resample to 48 kHz if the mix format differs.
        if sample_rate != 48_000 && !mono_buf.is_empty() {
            mono_buf = resample_linear(&std::mem::take(&mut mono_buf), sample_rate, 48_000);
        }

        // Flush complete batches.
        while mono_buf.len() >= BATCH_SAMPLES {
            let samples: Vec<f32> = mono_buf.drain(..BATCH_SAMPLES).collect();
            let raw: Vec<u8> = samples.iter().flat_map(|&f| f.to_le_bytes()).collect();
            let encoded = base64_encode(&raw);
            if on_chunk
                .send(AudioChunk {
                    data: encoded,
                    sample_rate: 48_000,
                    channels: 1,
                })
                .is_err()
            {
                stop.store(true, Ordering::Relaxed);
                break;
            }
        }
    }

    // Safety: client and ready_event were successfully created above.
    unsafe {
        let _ = client.Stop();
        let _ = CloseHandle(ready_event);
    }

    Ok(())
}
