//! The zero-copy screen-share path: a captured frame never leaves the GPU.
//!
//! Windows Graphics Capture hands out a `ID3D11Texture2D`, an `ID3D11VideoProcessor` scales and
//! converts it to NV12, and the encoder MFT takes that texture as a DXGI surface. The CPU only
//! ever touches the compressed bitstream on the way out.
//!
//! Windows only, and conditional even there: everything falls back to the RGBA pipeline in
//! `pump`/`fit`/`nv12` when the device, the capture session, the video processor or the encoder's
//! D3D manager will not build. See `session::start`.

pub mod capture;
pub mod pipeline;
pub mod convert;
pub mod device;

/// Turn the zero-copy path off without a rebuild.
///
/// The same kind of escape hatch as `VENTA_FORCE_SOFTWARE_ENCODER` and `VENTA_DISABLE_SIMULCAST`,
/// and for the same reason: this path depends on driver behaviour that cannot be proved from here,
/// so there has to be a way back that is not a release.
pub fn disabled() -> bool {
    std::env::var_os("VENTA_DISABLE_GPU_CAPTURE").is_some()
}
