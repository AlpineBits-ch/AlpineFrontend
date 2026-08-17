//! Scale, letterbox and BGRA to NV12, in one hardware pass per simulcast rung.
//!
//! `ID3D11VideoProcessor` does all three in a single `VideoProcessorBlt`, on the GPU's fixed
//! function video block rather than its shader cores, so it costs a game almost nothing. That is
//! what replaces `fit_into` plus `nv12::convert`, which together were 19 of the pump's 28 ms.
//!
//! Every raw call is funnelled through the helpers at the bottom of the file.

use std::sync::Arc;

use windows::core::Interface;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Texture2D, ID3D11VideoContext, ID3D11VideoDevice, ID3D11VideoProcessor,
    ID3D11VideoProcessorEnumerator, ID3D11VideoProcessorInputView, ID3D11VideoProcessorOutputView,
    D3D11_BIND_RENDER_TARGET, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT,
    D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE, D3D11_VIDEO_PROCESSOR_CONTENT_DESC,
    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0,
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC, D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0,
    D3D11_VIDEO_COLOR, D3D11_VIDEO_COLOR_0, D3D11_VIDEO_COLOR_RGBA,
    D3D11_VIDEO_PROCESSOR_COLOR_SPACE, D3D11_VIDEO_PROCESSOR_STREAM,
    D3D11_VIDEO_USAGE_PLAYBACK_NORMAL, D3D11_VPIV_DIMENSION_TEXTURE2D,
    D3D11_VPOV_DIMENSION_TEXTURE2D, D3D11_CPU_ACCESS_READ, D3D11_MAPPED_SUBRESOURCE,
    D3D11_MAP_READ, D3D11_TEX2D_VPIV, D3D11_TEX2D_VPOV, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::{
    DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_FORMAT_NV12, DXGI_RATIONAL, DXGI_SAMPLE_DESC,
};
use windows::Win32::Foundation::RECT;

use super::device::GpuDevice;
use crate::media::publisher::fit::fit_rect;

/// How many NV12 targets each rung cycles through.
///
/// Not one. An asynchronous MFT keeps hold of an input sample for a frame or two after
/// `ProcessInput` returns - that pipelining is why the encoder emits nothing for its first frames -
/// so writing the next frame into the texture it is still reading tears the picture it is halfway
/// through encoding. Three is one more than the deepest pipelining measured here.
const RUNG_SLOTS: usize = 3;

/// One NV12 target and the view the processor writes it through.
struct RungSlot {
    texture: ID3D11Texture2D,
    output_view: ID3D11VideoProcessorOutputView,
}

/// One rung's outputs: NV12 textures the encoder can take as-is, cycled so the encoder is never
/// reading the one being written.
pub struct Rung {
    slots: Vec<RungSlot>,
    next: usize,
    pub width: u32,
    pub height: u32,
}

/// Scales the captured texture into each rung of the ladder.
///
/// One processor per source geometry. The processor is built for a fixed input size, so a source
/// that changes size mid-share (a window being resized) rebuilds it.
pub struct GpuScaler {
    device: Arc<GpuDevice>,
    video_device: ID3D11VideoDevice,
    video_context: ID3D11VideoContext,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    /// What the processor was built for. A frame of any other size needs a new one.
    source: (u32, u32),
}

// Same argument as `GpuCapture`: COM objects held by reference, on a device with multithread
// protection on. Only ever driven from the capture thread.
unsafe impl Send for GpuScaler {}

impl GpuScaler {
    pub fn new(device: Arc<GpuDevice>, source: (u32, u32)) -> Result<Self, String> {
        let video_device: ID3D11VideoDevice = device
            .device
            .cast()
            .map_err(|e| format!("no ID3D11VideoDevice: {e}"))?;
        let video_context: ID3D11VideoContext = device
            .context
            .cast()
            .map_err(|e| format!("no ID3D11VideoContext: {e}"))?;

        let (enumerator, processor) = build_processor(&video_device, source)?;

        let scaler = Self {
            device,
            video_device,
            video_context,
            enumerator,
            processor,
            source,
        };
        scaler.set_colour_space();
        Ok(scaler)
    }

    /// Rebuild for a source that has changed size, e.g. a shared window being resized.
    pub fn retarget(&mut self, source: (u32, u32)) -> Result<(), String> {
        if self.source == source {
            return Ok(());
        }
        let (enumerator, processor) = build_processor(&self.video_device, source)?;
        self.enumerator = enumerator;
        self.processor = processor;
        self.source = source;
        self.set_colour_space();
        Ok(())
    }

    pub fn source(&self) -> (u32, u32) {
        self.source
    }

    /// An NV12 target of the given size, for one rung of the ladder.
    pub fn new_rung(&self, width: u32, height: u32) -> Result<Rung, String> {
        let mut slots = Vec::with_capacity(RUNG_SLOTS);
        for _ in 0..RUNG_SLOTS {
            let texture = new_nv12_texture(&self.device, width, height)?;
            let output_view = output_view(&self.video_device, &self.enumerator, &texture)?;
            slots.push(RungSlot {
                texture,
                output_view,
            });
        }
        Ok(Rung {
            slots,
            next: 0,
            width,
            height,
        })
    }

    /// Scale `frame` into the rung's next target, preserving aspect ratio and leaving black where
    /// it does not fill. Returns the texture that was written.
    ///
    /// The destination rectangle comes from the same `fit_rect` the CPU path uses, so a share
    /// letterboxes identically whichever pipeline produced it.
    pub fn blit<'a>(
        &self,
        frame: &ID3D11Texture2D,
        rung: &'a mut Rung,
    ) -> Result<&'a ID3D11Texture2D, String> {
        let input_view = input_view(&self.video_device, &self.enumerator, frame)?;
        let destination = fit_rect(self.source, (rung.width, rung.height));

        set_source_rect(&self.video_context, &self.processor, self.source);
        set_destination_rect(&self.video_context, &self.processor, &destination);

        let slot = rung.next;
        rung.next = (rung.next + 1) % rung.slots.len();

        // `ManuallyDrop` because the struct does not own the view: the reference count belongs to
        // `input_view` above, which lives until this call returns.
        let stream = D3D11_VIDEO_PROCESSOR_STREAM {
            Enable: true.into(),
            pInputSurface: std::mem::ManuallyDrop::new(Some(input_view.clone())),
            ..Default::default()
        };
        blt(
            &self.video_context,
            &self.processor,
            &rung.slots[slot].output_view,
            stream,
        )?;
        Ok(&rung.slots[slot].texture)
    }

    /// BT.709, limited range, signalled on both sides.
    ///
    /// The same matrix `nv12::convert` uses and the same one the encoder's input media type
    /// declares. Leaving it to the driver's default is how a share comes out with visibly shifted
    /// colour on one machine and not another.
    fn set_colour_space(&self) {
        set_stream_colour_space(&self.video_context, &self.processor);
        set_output_colour_space(&self.video_context, &self.processor);
    }
}

/// A small BGRA copy of the frame, read back for the sharer's thumbnail.
///
/// The one place on this path where pixels cross back over the bus, and the reason it is
/// affordable is the size: 480x270 five times a second is about half a megabyte a second, against
/// the 190 MB/s a full-frame download cost when every frame came back.
///
/// Only reached on a webview with no `VideoDecoder`. Everywhere else the sharer's own tile decodes
/// the encoded stream and this never runs at all.
pub struct PreviewTap {
    _target: ID3D11Texture2D,
    staging: ID3D11Texture2D,
    output_view: ID3D11VideoProcessorOutputView,
    width: u32,
    height: u32,
}

impl GpuScaler {
    /// A thumbnail-sized BGRA target, plus the staging texture to read it through.
    pub fn new_preview(&self, width: u32, height: u32) -> Result<PreviewTap, String> {
        let target = new_texture(
            &self.device,
            width,
            height,
            DXGI_FORMAT_B8G8R8A8_UNORM,
            D3D11_BIND_RENDER_TARGET.0 as u32,
            0,
            D3D11_USAGE_DEFAULT,
        )?;
        let staging = new_texture(
            &self.device,
            width,
            height,
            DXGI_FORMAT_B8G8R8A8_UNORM,
            0,
            D3D11_CPU_ACCESS_READ.0 as u32,
            D3D11_USAGE_STAGING,
        )?;
        let output_view = output_view(&self.video_device, &self.enumerator, &target)?;
        Ok(PreviewTap {
            _target: target,
            staging,
            output_view,
            width,
            height,
        })
    }

    /// Scale `frame` into the tap and bring the pixels back as RGBA.
    pub fn read_preview(
        &self,
        frame: &ID3D11Texture2D,
        tap: &PreviewTap,
    ) -> Result<image::RgbaImage, String> {
        let input_view = input_view(&self.video_device, &self.enumerator, frame)?;
        let destination = fit_rect(self.source, (tap.width, tap.height));
        set_source_rect(&self.video_context, &self.processor, self.source);
        set_destination_rect(&self.video_context, &self.processor, &destination);

        let stream = D3D11_VIDEO_PROCESSOR_STREAM {
            Enable: true.into(),
            pInputSurface: std::mem::ManuallyDrop::new(Some(input_view.clone())),
            ..Default::default()
        };
        blt(
            &self.video_context,
            &self.processor,
            &tap.output_view,
            stream,
        )?;

        copy_resource(&self.device, &tap.staging, &tap._target);
        read_bgra(&self.device, &tap.staging, tap.width, tap.height)
    }
}

// ── The raw D3D11 video surface ───────────────────────────────────────────────
//
// One-call wrappers around COM methods the `windows` crate declares unsafe. Sound throughout for
// the same reason: every pointer comes from a live, reference-counted object the caller holds, and
// the device carries multithread protection.

fn build_processor(
    video_device: &ID3D11VideoDevice,
    source: (u32, u32),
) -> Result<(ID3D11VideoProcessorEnumerator, ID3D11VideoProcessor), String> {
    let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
        InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
        InputFrameRate: DXGI_RATIONAL {
            Numerator: 60,
            Denominator: 1,
        },
        InputWidth: source.0,
        InputHeight: source.1,
        OutputFrameRate: DXGI_RATIONAL {
            Numerator: 60,
            Denominator: 1,
        },
        OutputWidth: source.0,
        OutputHeight: source.1,
        // A screen share is latency-bound, not quality-bound: the processor should not be spending
        // time on the frame it is about to hand to an encoder that will requantise it anyway.
        Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
    };

    let enumerator = unsafe { video_device.CreateVideoProcessorEnumerator(&desc) }
        .map_err(|e| format!("no video processor enumerator: {e}"))?;
    let processor = unsafe { video_device.CreateVideoProcessor(&enumerator, 0) }
        .map_err(|e| format!("no video processor: {e}"))?;
    Ok((enumerator, processor))
}

fn new_nv12_texture(
    device: &GpuDevice,
    width: u32,
    height: u32,
) -> Result<ID3D11Texture2D, String> {
    // Render target so the video processor can write it. The encoder MFT reads it as a DXGI
    // surface and needs no bind flag of its own.
    new_texture(
        device,
        width,
        height,
        DXGI_FORMAT_NV12,
        D3D11_BIND_RENDER_TARGET.0 as u32,
        0,
        D3D11_USAGE_DEFAULT,
    )
}

fn new_texture(
    device: &GpuDevice,
    width: u32,
    height: u32,
    format: windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT,
    bind_flags: u32,
    cpu_access: u32,
    usage: windows::Win32::Graphics::Direct3D11::D3D11_USAGE,
) -> Result<ID3D11Texture2D, String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: format,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: usage,
        BindFlags: bind_flags,
        CPUAccessFlags: cpu_access,
        MiscFlags: 0,
    };
    let mut texture = None;
    unsafe { device.device.CreateTexture2D(&desc, None, Some(&mut texture)) }
        .map_err(|e| format!("could not create a {width}x{height} texture: {e}"))?;
    texture.ok_or_else(|| "CreateTexture2D returned nothing".to_string())
}

fn copy_resource(device: &GpuDevice, destination: &ID3D11Texture2D, source: &ID3D11Texture2D) {
    unsafe { device.context.CopyResource(destination, source) };
}

/// Map a staging texture and turn its BGRA rows into an `RgbaImage`.
///
/// Row-by-row rather than one slice: the driver picks the pitch and it is routinely wider than the
/// image, so a flat copy would shear the picture.
fn read_bgra(
    device: &GpuDevice,
    staging: &ID3D11Texture2D,
    width: u32,
    height: u32,
) -> Result<image::RgbaImage, String> {
    let resource: windows::Win32::Graphics::Direct3D11::ID3D11Resource = staging
        .cast()
        .map_err(|e| format!("no ID3D11Resource: {e}"))?;
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    unsafe {
        device
            .context
            .Map(&resource, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
    }
    .map_err(|e| format!("could not map the preview: {e}"))?;

    let mut out = vec![0u8; (width * height * 4) as usize];
    // Reading `RowPitch` bytes per row out of a buffer the driver owns for the duration of the
    // map. The pointer and the pitch both come from the successful `Map` above.
    for row in 0..height as usize {
        let source = unsafe {
            std::slice::from_raw_parts(
                (mapped.pData as *const u8).add(row * mapped.RowPitch as usize),
                width as usize * 4,
            )
        };
        let destination = &mut out[row * width as usize * 4..(row + 1) * width as usize * 4];
        for (pixel, bgra) in destination.chunks_exact_mut(4).zip(source.chunks_exact(4)) {
            pixel[0] = bgra[2];
            pixel[1] = bgra[1];
            pixel[2] = bgra[0];
            pixel[3] = 255;
        }
    }

    unsafe { device.context.Unmap(&resource, 0) };
    image::RgbaImage::from_raw(width, height, out)
        .ok_or_else(|| "the preview readback was the wrong size".to_string())
}

fn input_view(
    video_device: &ID3D11VideoDevice,
    enumerator: &ID3D11VideoProcessorEnumerator,
    texture: &ID3D11Texture2D,
) -> Result<ID3D11VideoProcessorInputView, String> {
    let desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
        FourCC: 0,
        ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
        Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 {
            Texture2D: D3D11_TEX2D_VPIV {
                MipSlice: 0,
                ArraySlice: 0,
            },
        },
    };
    let mut view = None;
    unsafe {
        video_device.CreateVideoProcessorInputView(texture, enumerator, &desc, Some(&mut view))
    }
    .map_err(|e| format!("no processor input view: {e}"))?;
    view.ok_or_else(|| "CreateVideoProcessorInputView returned nothing".to_string())
}

fn output_view(
    video_device: &ID3D11VideoDevice,
    enumerator: &ID3D11VideoProcessorEnumerator,
    texture: &ID3D11Texture2D,
) -> Result<ID3D11VideoProcessorOutputView, String> {
    let desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
        ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
        Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 {
            Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 },
        },
    };
    let mut view = None;
    unsafe {
        video_device.CreateVideoProcessorOutputView(texture, enumerator, &desc, Some(&mut view))
    }
    .map_err(|e| format!("no processor output view: {e}"))?;
    view.ok_or_else(|| "CreateVideoProcessorOutputView returned nothing".to_string())
}

fn set_source_rect(
    context: &ID3D11VideoContext,
    processor: &ID3D11VideoProcessor,
    source: (u32, u32),
) {
    let rect = RECT {
        left: 0,
        top: 0,
        right: source.0 as i32,
        bottom: source.1 as i32,
    };
    unsafe { context.VideoProcessorSetStreamSourceRect(processor, 0, true, Some(&rect)) };
}

fn set_destination_rect(
    context: &ID3D11VideoContext,
    processor: &ID3D11VideoProcessor,
    destination: &crate::media::publisher::fit::FitRect,
) {
    let rect = RECT {
        left: destination.x as i32,
        top: destination.y as i32,
        right: (destination.x + destination.width) as i32,
        bottom: (destination.y + destination.height) as i32,
    };
    unsafe { context.VideoProcessorSetStreamDestRect(processor, 0, true, Some(&rect)) };
    // Anything the picture does not cover is the letterbox, and it has to be opaque black or the
    // encoder turns whatever was left in the texture into visible garbage at the edges.
    unsafe {
        context.VideoProcessorSetOutputBackgroundColor(processor, false, &BLACK);
    }
}

const BLACK: D3D11_VIDEO_COLOR = D3D11_VIDEO_COLOR {
    Anonymous: D3D11_VIDEO_COLOR_0 {
        RGBA: D3D11_VIDEO_COLOR_RGBA {
            R: 0.0,
            G: 0.0,
            B: 0.0,
            A: 1.0,
        },
    },
};

/// The input is full-range RGB, which is what the desktop composites in.
///
/// Bit 0 of the bitfield is `Usage` and bit 1 is `RGB_Range`, where 0 means full. Zero is
/// therefore already correct for the source, and it is set explicitly so a driver default can
/// never make it something else.
fn set_stream_colour_space(context: &ID3D11VideoContext, processor: &ID3D11VideoProcessor) {
    let space = D3D11_VIDEO_PROCESSOR_COLOR_SPACE::default();
    unsafe { context.VideoProcessorSetStreamColorSpace(processor, 0, &space) };
}

/// BT.709, studio range, on the way out.
///
/// The same matrix `nv12::convert` uses and the same one the encoder's input media type declares.
/// Bit 2 is `Nominal_Range` (0 for 16-235) and bit 3 is `YCbCr_Matrix` (1 for BT.709). Leaving
/// this to the driver is how a share comes out with visibly shifted colour on one machine only.
fn set_output_colour_space(context: &ID3D11VideoContext, processor: &ID3D11VideoProcessor) {
    let space = D3D11_VIDEO_PROCESSOR_COLOR_SPACE { _bitfield: 1 << 3 };
    unsafe { context.VideoProcessorSetOutputColorSpace(processor, &space) };
}

fn blt(
    context: &ID3D11VideoContext,
    processor: &ID3D11VideoProcessor,
    output: &ID3D11VideoProcessorOutputView,
    stream: D3D11_VIDEO_PROCESSOR_STREAM,
) -> Result<(), String> {
    unsafe { context.VideoProcessorBlt(processor, output, 0, &[stream]) }
        .map_err(|e| format!("VideoProcessorBlt failed: {e}"))
}
