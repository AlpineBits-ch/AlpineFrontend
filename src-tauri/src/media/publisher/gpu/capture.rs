//! One Windows Graphics Capture session, held open for the life of a share.
//!
//! The measured fault this replaces: `xcap`'s `capture_image` builds a device wrapper, a frame
//! pool and a capture session per grab and tears them all down again. Setup never fits inside one
//! refresh period, so every grab lost whole periods, and a grab of a 64x64 region cost the same
//! 13.3 ms as a grab of the whole 1080p screen. Holding the session open takes that to nothing and
//! leaves the display's own refresh rate as the only ceiling.
//!
//! The WinRT half of this (the pool, the session, the frames) is safe in the `windows` projection.
//! Every raw D3D11 call is funnelled through the handful of helpers at the bottom of the file, so
//! nothing above them needs an `unsafe` block to read.

use std::sync::{Arc, Mutex};

use windows::core::{IInspectable, Interface};
use windows::Foundation::TypedEventHandler;
use windows::Graphics::Capture::{
    Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::HWND;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Texture2D, D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_TEXTURE2D_DESC,
    D3D11_USAGE_DEFAULT,
};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Graphics::Gdi::HMONITOR;
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;

use super::device::GpuDevice;

/// How many surfaces the capture pool holds.
///
/// Two, so the compositor can fill one while the arrival callback copies the other. One stalls the
/// compositor on our copy; more only adds latency, because a frame we have not consumed by the
/// time the next arrives is one we are going to drop anyway.
const POOL_BUFFERS: i32 = 2;

/// The newest captured frame, and the textures to recycle it through.
///
/// A single slot rather than a queue, on purpose. A share that has fallen behind wants the newest
/// frame and not the oldest, which is the same rule the writer channel follows with `try_send`.
#[derive(Default)]
struct Latest {
    /// Filled by the arrival callback, taken by the capture thread.
    ready: Option<ID3D11Texture2D>,
    /// Textures the capture thread has finished with, waiting to be written into again.
    spare: Vec<ID3D11Texture2D>,
}

/// A captured frame the caller owns until it hands the texture back.
pub struct GpuFrame {
    pub texture: ID3D11Texture2D,
    pub width: u32,
    pub height: u32,
}

pub struct GpuCapture {
    device: Arc<GpuDevice>,
    latest: Arc<Mutex<Latest>>,
    /// Held so the session stays open. Closing either half ends capture.
    _frame_pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    /// What the source measured when the session opened.
    size: (u32, u32),
}

// The WinRT capture objects are agile, the D3D device is free-threaded, and `latest` is the only
// mutable state and sits behind a mutex. What makes this sound rather than merely plausible is the
// multithread protection `GpuDevice::new` sets: the arrival callback and the capture thread both
// touch the immediate context.
unsafe impl Send for GpuCapture {}
unsafe impl Sync for GpuCapture {}

impl GpuCapture {
    /// Open a session on a monitor or a window, named the way `find_capture_source` names them.
    pub fn open(source_id: &str, device: Arc<GpuDevice>) -> Result<Self, String> {
        let item = capture_item(source_id)?;
        let size = item.Size().map_err(|e| format!("no item size: {e}"))?;
        if size.Width <= 0 || size.Height <= 0 {
            return Err(format!(
                "{source_id} has no pixels ({}x{})",
                size.Width, size.Height
            ));
        }

        let winrt_device = winrt_device_for(&device)?;

        // Free-threaded, so arrivals land on the thread pool rather than needing a message loop on
        // ours. The capture thread does not pump messages and never will.
        let frame_pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &winrt_device,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            POOL_BUFFERS,
            size,
        )
        .map_err(|e| format!("could not create a frame pool: {e}"))?;

        let latest = Arc::new(Mutex::new(Latest::default()));
        let handler_device = Arc::clone(&device);
        let handler_latest = Arc::clone(&latest);

        frame_pool
            .FrameArrived(&TypedEventHandler::<
                Direct3D11CaptureFramePool,
                IInspectable,
            >::new(move |pool, _| {
                if let Some(pool) = pool.as_ref() {
                    on_frame_arrived(pool, &handler_device, &handler_latest);
                }
                Ok(())
            }))
            .map_err(|e| format!("could not subscribe to frames: {e}"))?;

        let session = frame_pool
            .CreateCaptureSession(&item)
            .map_err(|e| format!("could not create a capture session: {e}"))?;
        // Best-effort: both need Windows 11 builds and capabilities we cannot rely on, and a share
        // with a capture border around it is still a share.
        let _ = session.SetIsBorderRequired(false);
        let _ = session.SetIsCursorCaptureEnabled(true);
        session
            .StartCapture()
            .map_err(|e| format!("could not start capturing: {e}"))?;

        Ok(Self {
            device,
            latest,
            _frame_pool: frame_pool,
            session,
            size: (size.Width as u32, size.Height as u32),
        })
    }

    /// What the source measured when the session opened.
    pub fn source_size(&self) -> (u32, u32) {
        self.size
    }

    /// The newest frame, or `None` when nothing has been presented since the last call.
    ///
    /// `None` is routine rather than a fault: Windows Graphics Capture is change-driven, so a
    /// desktop holding still produces nothing at all. The caller re-encodes what it already holds,
    /// which is what keeps the keyframe clock running on a screen nobody is touching.
    pub fn take_latest(&self) -> Option<GpuFrame> {
        let texture = self.latest.lock().ok()?.ready.take()?;
        let desc = describe(&texture);
        Some(GpuFrame {
            width: desc.Width,
            height: desc.Height,
            texture,
        })
    }

    /// Hand a frame's texture back to be written into again.
    pub fn recycle(&self, frame: GpuFrame) {
        if let Ok(mut latest) = self.latest.lock() {
            // Bounded by the pool, so a caller that never consumes cannot grow this without limit.
            if latest.spare.len() <= POOL_BUFFERS as usize {
                latest.spare.push(frame.texture);
            }
        }
    }
}

impl Drop for GpuCapture {
    fn drop(&mut self) {
        // The session keeps the compositor delivering frames. Leaving it open is a capture that
        // outlives the share that asked for it.
        let _ = self.session.Close();
    }
}

/// Copy the arriving surface into a texture of our own and publish it.
///
/// The copy is not avoidable and is not the cost: the pool recycles its surface the moment the
/// frame closes, so holding one would stall the compositor on our encode. A `CopyResource` of 8 MB
/// is a few hundred microseconds against the hundreds of gigabytes a second a card has.
fn on_frame_arrived(pool: &Direct3D11CaptureFramePool, device: &GpuDevice, latest: &Mutex<Latest>) {
    let Ok(frame) = pool.TryGetNextFrame() else {
        return;
    };
    let Ok(surface) = frame.Surface() else {
        return;
    };
    let Some(source) = texture_of(&surface) else {
        return;
    };
    let desc = describe(&source);

    let Ok(mut slot) = latest.lock() else {
        return;
    };
    // A spare of the wrong size is left over from before the source was resized, and is dropped.
    let recycled = slot.spare.pop().filter(|texture| {
        let existing = describe(texture);
        existing.Width == desc.Width && existing.Height == desc.Height
    });
    let Some(destination) = recycled.or_else(|| new_texture(device, &desc)) else {
        return;
    };

    copy_texture(device, &destination, &source);

    // Whatever was in the slot was never consumed, so this frame is newer and that one is dropped.
    if let Some(stale) = slot.ready.replace(destination) {
        slot.spare.push(stale);
    }
    // `frame` closes here, returning the surface to the pool.
}

/// Resolve one of `find_capture_source`'s ids to a capture item.
///
/// `monitor:N` is an index into the same enumeration the picker used and `window:N` is the raw
/// `HWND`, both resolved through `xcap` rather than a second enumeration of our own - so the
/// picker and the capture cannot disagree about which source an id names.
fn capture_item(source_id: &str) -> Result<GraphicsCaptureItem, String> {
    let interop = windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
        .map_err(|e| format!("no capture interop: {e}"))?;

    if let Some(index) = source_id.strip_prefix("monitor:") {
        let index: usize = index
            .parse()
            .map_err(|_| format!("bad monitor id {source_id}"))?;
        let monitor = xcap::Monitor::all()
            .map_err(|e| e.to_string())?
            .into_iter()
            .nth(index)
            .ok_or_else(|| format!("no monitor at index {index}"))?;
        let handle = monitor.id().map_err(|e| e.to_string())?;
        return item_for_monitor(&interop, handle)
            .map_err(|e| format!("could not capture monitor {index}: {e}"));
    }

    if let Some(handle) = source_id.strip_prefix("window:") {
        let handle: u32 = handle
            .parse()
            .map_err(|_| format!("bad window id {source_id}"))?;
        return item_for_window(&interop, handle)
            .map_err(|e| format!("could not capture window {handle}: {e}"));
    }

    Err(format!("unrecognised capture source {source_id}"))
}

// ── The raw D3D11 surface ─────────────────────────────────────────────────────
//
// Everything below is a one-call wrapper around a COM method the `windows` crate declares unsafe.
// They are sound for the same two reasons throughout: every interface pointer comes from a live,
// reference-counted COM object held by the caller, and the device's multithread protection covers
// the context being touched from both the arrival callback and the capture thread.

/// The WinRT device wrapper the capture pool needs, over our own D3D11 device.
fn winrt_device_for(device: &GpuDevice) -> Result<IDirect3DDevice, String> {
    let dxgi: IDXGIDevice = device
        .device
        .cast()
        .map_err(|e| format!("no IDXGIDevice: {e}"))?;
    let inspectable = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }
        .map_err(|e| format!("no WinRT device: {e}"))?;
    inspectable
        .cast::<IDirect3DDevice>()
        .map_err(|e| format!("no IDirect3DDevice: {e}"))
}

/// The D3D11 texture behind a captured frame's surface.
fn texture_of(surface: &windows::Graphics::DirectX::Direct3D11::IDirect3DSurface) -> Option<ID3D11Texture2D> {
    let access = surface.cast::<IDirect3DDxgiInterfaceAccess>().ok()?;
    unsafe { access.GetInterface::<ID3D11Texture2D>() }.ok()
}

/// A texture's dimensions and format.
pub fn describe(texture: &ID3D11Texture2D) -> D3D11_TEXTURE2D_DESC {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { texture.GetDesc(&mut desc) };
    desc
}

/// A texture matching the captured surface, usable as a video processor input.
fn new_texture(device: &GpuDevice, source: &D3D11_TEXTURE2D_DESC) -> Option<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: source.Width,
        Height: source.Height,
        MipLevels: 1,
        ArraySize: 1,
        Format: source.Format,
        SampleDesc: source.SampleDesc,
        // Default usage, no CPU access. Nothing reads this from the CPU: that is the whole point.
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: (D3D11_BIND_SHADER_RESOURCE.0 | D3D11_BIND_RENDER_TARGET.0) as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let mut texture = None;
    unsafe { device.device.CreateTexture2D(&desc, None, Some(&mut texture)) }.ok()?;
    texture
}

/// Copy one whole texture onto another of the same size and format.
fn copy_texture(device: &GpuDevice, destination: &ID3D11Texture2D, source: &ID3D11Texture2D) {
    unsafe { device.context.CopyResource(destination, source) };
}

fn item_for_monitor(
    interop: &IGraphicsCaptureItemInterop,
    handle: u32,
) -> windows::core::Result<GraphicsCaptureItem> {
    unsafe { interop.CreateForMonitor(HMONITOR(handle as isize as *mut _)) }
}

fn item_for_window(
    interop: &IGraphicsCaptureItemInterop,
    handle: u32,
) -> windows::core::Result<GraphicsCaptureItem> {
    unsafe { interop.CreateForWindow(HWND(handle as isize as *mut _)) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unrecognised_source_is_rejected_rather_than_guessed() {
        for id in ["", "screen:0", "monitor", "window:", "monitor:not-a-number"] {
            assert!(capture_item(id).is_err(), "{id} should not resolve");
        }
    }
}
