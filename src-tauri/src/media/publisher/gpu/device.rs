//! The one D3D11 device the zero-copy path runs on.
//!
//! Capture, the scaler and the encoder all have to be on this device. A texture cannot cross
//! devices without a shared-handle round trip, and that round trip is the copy this whole path
//! exists to remove.

use windows::core::Interface;
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Multithread,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_SDK_VERSION,
};

pub struct GpuDevice {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
}

// D3D11 devices are free-threaded. The immediate context is not, until the multithread protection
// `new` turns on: Windows Graphics Capture delivers frames on a thread pool it owns while the
// capture thread is reading, and both touch the context. Without that call this is unsound.
unsafe impl Send for GpuDevice {}
unsafe impl Sync for GpuDevice {}

impl GpuDevice {
    pub fn new() -> Result<Self, String> {
        let mut device = None;
        let mut context = None;
        // 11_1 first for the newer video processor capabilities, 11_0 as the floor. Anything that
        // cannot manage 11_0 has no hardware encoder either and is on the CPU path regardless.
        let levels = [D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0];

        unsafe {
            D3D11CreateDevice(
                // The default adapter, which is the one the desktop is composited on. Picking a
                // specific one would be wrong on a laptop that switches GPUs.
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE::default(),
                // BGRA for the capture surface format, VIDEO for the processor that scales and
                // converts it. Without the video flag `ID3D11VideoDevice` cannot be obtained at all.
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                Some(&levels),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
            .map_err(|e| format!("D3D11CreateDevice failed: {e}"))?;
        }

        let device = device.ok_or("D3D11CreateDevice returned no device")?;
        let context = context.ok_or("D3D11CreateDevice returned no context")?;

        let multithread: ID3D11Multithread = device
            .cast()
            .map_err(|e| format!("no ID3D11Multithread on the device: {e}"))?;
        // Returns the previous setting, which nothing here needs.
        let _previous = unsafe { multithread.SetMultithreadProtected(true) };

        Ok(Self { device, context })
    }
}
