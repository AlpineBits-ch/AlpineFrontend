//! Hardware H.264 encoding through Media Foundation.
//!
//! Media Foundation fronts whatever the GPU vendor provides - NVENC, QuickSync, AMF - behind one
//! `IMFTransform` interface, so a single implementation covers all three and the OS carries the
//! H.264 patent licence.
//!
//! The wrinkle is that hardware encoder MFTs are *asynchronous*: you may not call `ProcessInput`
//! whenever you like, only in response to a `METransformNeedInput` event, and output arrives via
//! `METransformHaveOutput` some frames later. That event pump is most of the code here.

use std::collections::VecDeque;
use std::mem::ManuallyDrop;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use image::RgbaImage;
use windows::core::Interface;
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::CoIncrementMTAUsage;

use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11Texture2D};

use super::encoder::{
    CapturedFrame, EncodeOutcome, EncodedChunk, EncoderContent, EncoderSpec, VideoEncoder,
};
use super::nv12;

/// How long a single frame may spend waiting on the encoder before we give up on it.
///
/// Generous next to a frame interval (16 ms at 60 fps) but far below anything a user would notice
/// as a stall, so a wedged encoder is detected in a few frames rather than hanging capture.
const FRAME_DEADLINE: Duration = Duration::from_millis(100);

/// How long teardown waits for the transform to report that it has drained.
///
/// Longer than [`FRAME_DEADLINE`] because a drain has to flush frames the encoder is still holding,
/// and it is paid once when a share stops or changes resolution rather than once per frame.
const DRAIN_DEADLINE: Duration = Duration::from_millis(500);

/// Media Foundation must be initialised once per process before any MF call.
static MF_STARTED: OnceLock<bool> = OnceLock::new();

fn ensure_mf_started() -> bool {
    // Also installed from `run()`, but idempotent and cheap - and the tests never go through
    // `run()`, so this is what covers them.
    crate::crash_reporter::install();
    *MF_STARTED.get_or_init(|| unsafe {
        // Keep the process MTA alive before any MF call, for the same reason `media::loopback_win`
        // does it - see the note there. A hardware MFT hands its work to MF's real-time work queue
        // and calls back on threads it owns; those callbacks and our releases have to meet in an
        // apartment that outlives both. cpal initialises COM as STA on whatever thread it touches,
        // and a CoUninitialize anywhere can otherwise drop the last MTA reference for the process.
        //
        // Never decremented: the cookie is deliberately discarded.
        let _ = CoIncrementMTAUsage();
        // NOSOCKET: we only ever run transforms locally, never the network source.
        MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET).is_ok()
    })
}

/// Pack two 32-bit values into the UINT64 layout MF uses for size and ratio attributes.
fn pack(high: u32, low: u32) -> u64 {
    ((high as u64) << 32) | low as u64
}

/// How the encoder should spend the preset's budget, in the four codec-API values that say so.
///
/// <p>A struct rather than four `SetValue` calls inline because those calls cannot be observed: MF
/// swallows a rejected `SetValue`, every one here is `let _ =`, and no hardware encoder exists in
/// CI. Deciding the values separately from applying them is what lets the decision be tested at all
/// - and this is the decision that was wrong before the content mode existed, so it is the one worth
/// pinning.</p>
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RatePlan {
    mode: u32,
    mean_bps: u32,
    /// Set only where the mode is variable; `None` leaves MF's own ceiling alone.
    peak_bps: Option<u32>,
    /// 0-100, where 100 is all quality. `None` keeps the driver's default.
    quality_vs_speed: Option<u32>,
}

impl RatePlan {
    fn for_spec(spec: EncoderSpec) -> Self {
        let mean_bps = spec.kbps.saturating_mul(1000);
        match spec.content {
            // Continuous motion: an even spend is what the picture needs, and CBR is the mode every
            // vendor's encoder implements best.
            EncoderContent::Games => Self {
                mode: eAVEncCommonRateControlMode_CBR.0 as u32,
                mean_bps,
                peak_bps: None,
                quality_vs_speed: None,
            },
            // A desktop holds still most of the time. CBR spends the budget on frames nobody needed
            // and then clips the scroll that follows, which is the single biggest reason text looked
            // soft on this path. Peak-constrained VBR lets the cost fall to almost nothing while the
            // screen is static and burst to twice the target when it is not, with the mean still the
            // preset's own number. The quality bias buys the edges that make small text readable,
            // which a mostly-static screen leaves the encoder time to find.
            EncoderContent::Text => Self {
                mode: eAVEncCommonRateControlMode_PeakConstrainedVBR.0 as u32,
                mean_bps,
                peak_bps: Some(mean_bps.saturating_mul(2)),
                quality_vs_speed: Some(70),
            },
        }
    }
}

pub struct MediaFoundationEncoder {
    /// The activation object the transform came from.
    ///
    /// Kept only so that `ShutdownObject` can be called on it. Media Foundation requires that of
    /// every object obtained through `ActivateObject`, and releasing the transform is not a
    /// substitute: for a hardware MFT it is the shutdown that hands the encode session back to the
    /// driver. Enumerating activates every H.264 encoder the machine has - three on the machine
    /// this was written against - so a publish that never shut down the ones it rejected left two
    /// sessions held for the life of the process, and a later publish met an encoder that was
    /// already in use.
    activate: IMFActivate,
    transform: IMFTransform,
    /// Present only for asynchronous transforms, which in practice means all hardware ones.
    events: Option<IMFMediaEventGenerator>,
    codec_api: Option<ICodecAPI>,
    spec: EncoderSpec,
    /// Only used on the CPU path. Empty and untouched once `bind_to_device` has succeeded.
    nv12_buf: Vec<u8>,
    /// Present once the transform has been pointed at the device its input textures live on.
    /// Its presence is what says this encoder takes textures rather than buffers.
    device_manager: Option<IMFDXGIDeviceManager>,
    /// Output runs a few frames behind input, so completed frames queue here.
    pending: VecDeque<EncodedChunk>,
    /// Timestamps queued in submission order, to pair with output that arrives later.
    inflight: VecDeque<u64>,
}

// The transform is only ever touched from the single capture thread that owns the encoder.
unsafe impl Send for MediaFoundationEncoder {}

impl MediaFoundationEncoder {
    /// Module-private on purpose: everything outside goes through [`PooledEncoder`].
    ///
    /// A `MediaFoundationEncoder` must not be dropped, which is the crash this module is built
    /// around, so the type that owns one has to be the type that knows not to destroy it. Keeping
    /// this private is what stops a later caller reintroducing the fault by constructing one.
    fn new(spec: EncoderSpec) -> Option<Self> {
        if spec.width % 2 != 0 || spec.height % 2 != 0 || spec.width == 0 || spec.height == 0 {
            return None;
        }
        if !ensure_mf_started() {
            return None;
        }

        for activate in unsafe { enumerate_hardware_encoders() } {
            // Activated here, one at a time, so that returning below never leaves an encoder
            // created-but-abandoned. See `enumerate_hardware_encoders`.
            let transform = match unsafe { activate.ActivateObject::<IMFTransform>() } {
                Ok(transform) => transform,
                Err(e) => {
                    eprintln!("[publisher] a hardware encoder would not activate: {e}");
                    continue;
                }
            };

            // Which MFT this actually is. `MFT_ENUM_FLAG_HARDWARE` covers every vendor on the
            // machine and the loop falls through to the next when one will not configure, so
            // without this the log cannot tell "NVENC" from "NVENC refused, this is QuickSync" -
            // and NVIDIA's encoder runs out of sessions (twelve, measured on this machine) and
            // starts refusing, so that fallback is a normal occurrence rather than an edge case.
            let name = unsafe { friendly_name(&activate) };

            match unsafe { Self::configure(activate.clone(), transform, spec) } {
                Ok(encoder) => {
                    eprintln!("[publisher] hardware encoder: {name}");
                    return Some(encoder);
                }
                Err(e) => {
                    eprintln!("[publisher] {name} failed to configure: {e}");
                    // An encoder we are not going to use must go back to the driver now. Releasing
                    // the interface does not do it; only the shutdown does.
                    unsafe {
                        let _ = activate.ShutdownObject();
                    }
                }
            }
        }
        None
    }

    /// Set the codec parameters and both media types for `spec`.
    ///
    /// Split out of `configure` because it is also what a geometry change re-runs. The encoder is
    /// never rebuilt for a new resolution: destroying a used NVIDIA MFT faults inside the driver's
    /// own work queue, so the one that survives is the one we keep.
    unsafe fn apply_spec(
        transform: &IMFTransform,
        codec_api: Option<&ICodecAPI>,
        spec: EncoderSpec,
    ) -> Result<(), String> {
        if let Some(api) = &codec_api {
                // Low latency matters more than compression efficiency for a live screen share: it
                // caps how many frames the encoder may hold before emitting one.
                let _ = api.SetValue(&CODECAPI_AVLowLatencyMode, &true.into());

                let plan = RatePlan::for_spec(spec);
                // The mode is reported on failure rather than swallowed, because this is also the
                // path a *live* Games/Text switch takes: `retype` re-applies the whole plan to a
                // transform that is already streaming, and rate control mode is one of the settings
                // a hardware MFT is entitled to refuse once it has started. Discarding that error
                // leaves the bar showing a mode the encoder is not in, with nothing anywhere saying
                // so - the same failure the keyframe interval below already learned to make loud.
                if let Err(e) = api.SetValue(&CODECAPI_AVEncCommonRateControlMode, &plan.mode.into())
                {
                    eprintln!(
                        "[publisher] this encoder refused rate control mode {} ({e}); the share is \
                         still encoding in its previous mode",
                        plan.mode
                    );
                }
                let _ = api.SetValue(&CODECAPI_AVEncCommonMeanBitRate, &plan.mean_bps.into());
                // The peak is what makes VBR VBR - without it the mode is nominal - so a refusal
                // here is the same class of silent downgrade as the mode itself.
                if let Some(peak) = plan.peak_bps {
                    if let Err(e) = api.SetValue(&CODECAPI_AVEncCommonMaxBitRate, &peak.into()) {
                        eprintln!(
                            "[publisher] this encoder refused a {peak} bps ceiling ({e}); text mode \
                             will not burst above its mean"
                        );
                    }
                }
                if let Some(quality) = plan.quality_vs_speed {
                    let _ = api.SetValue(&CODECAPI_AVEncCommonQualityVsSpeed, &quality.into());
                }
            }

            // Output type must be set before input type on an encoder MFT.
            let output = MFCreateMediaType().map_err(|e| e.to_string())?;
            output
                .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
                .and_then(|_| output.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264))
                .and_then(|_| output.SetUINT32(&MF_MT_AVG_BITRATE, spec.kbps.saturating_mul(1000)))
                .and_then(|_| output.SetUINT64(&MF_MT_FRAME_SIZE, pack(spec.width, spec.height)))
                .and_then(|_| output.SetUINT64(&MF_MT_FRAME_RATE, pack(spec.fps.max(1), 1)))
                .and_then(|_| output.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1)))
                .and_then(|_| {
                    output.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
                })
                // **Constrained Baseline, and the level is what 2K actually needed.**
                //
                // Profile and level are separate knobs and conflating them cost several rounds of
                // this. *Level* is what makes a resolution legal - `rtc.rs` declares `42e034`,
                // Level 5.2, whose MaxFS 36864 and MaxMBPS 2073600 cover 1440p60 with room to
                // spare. *Profile* is only quality: High brings CABAC and the 8x8 transform, worth
                // roughly 10-20% BD-rate on the small text a share is mostly made of.
                //
                // High was tried, on the strength of LiveKit keeping `640034` in its answer where
                // Cloudflare dropped it. **It renders as a black tile on most Android handsets.**
                // An SFU does not transcode, so every subscriber has to decode the one profile we
                // send, and libwebrtc selects a codec by profile *equality* - level never blocks a
                // match, `level-asymmetry-allowed=1` is on every entry. A device on Codec2 codec
                // naming, which is the norm since Android 10, advertises Constrained Baseline and
                // nothing else, as an encoder and as a decoder. Plain High matches nothing it
                // offers. See `lib/core/voice/video_layers.dart` in venta-mobile, which audits the
                // shipped AAR for exactly this.
                //
                // Constrained High (`640c34`) is not the escape either: the MFT accepts
                // `UCConstrainedHigh` and then fails mid-encode, silently costing the hardware
                // encoder for the session, and only Qualcomm and Exynos handsets advertise it.
                //
                // So the ladder is conformant at 2K by *level*, and decodable everywhere by
                // *profile*, and the 10-20% is the price. Revisit when libwebrtc teaches its
                // Android factories Codec2 names - that is what would make High general rather
                // than a Qualcomm and Exynos privilege.
                //
                // Two things that did NOT change and are easy to conflate with this:
                //
                //  * **Level is not set here at all.** Only the profile is. Media Foundation
                //    derives the level from geometry, framerate and bitrate, and `rtc.rs` declares
                //    5.2 in the fmtp. Declaring more than we send is the safe direction - a
                //    receiver allocates for the ceiling and is never surprised.
                //  * **`encoder_sw` stays Baseline.** OpenH264 is the fallback path and sets no
                //    profile; a share that lands on it is unaffected by this line.
                //
                // Constrained Baseline also has no B-frames, so the `zero B-frame count` refusal
                // this encoder logs under High - and the reordering latency behind it - goes with
                // it.
                .and_then(|_| {
                    output.SetUINT32(
                        &MF_MT_MPEG2_PROFILE,
                        eAVEncH264VProfile_ConstrainedBase.0 as u32,
                    )
                })
                .map_err(|e| e.to_string())?;
            transform
                .SetOutputType(0, &output, 0)
                .map_err(|e| format!("SetOutputType failed: {e}"))?;

            // A periodic IDR, matching what the software encoder configures - and set *here*, after the
            // output type, because that is the only point at which an encoder MFT will accept it.
            //
            // Without an IDR the picture never appears for anyone who was not watching from the first
            // frame. Left to its defaults, and especially with low-latency mode on, a Media Foundation
            // encoder emits one IDR at the start of the stream and then P-frames indefinitely. A viewer
            // subscribes some time after a share begins, so they reliably miss that single IDR, and a
            // decoder with no keyframe shows black. They cannot ask for one either: the RTCP a viewer
            // sends to request a keyframe is read and discarded in `publisher::rtc`, so nothing on this
            // side ever calls `request_keyframe`.
            //
            // It is invisible to the person sharing, whose own preview is drawn from the capture source
            // rather than the encoded stream, and it reproduced only against the hardware encoder - the
            // software path sets `intra_frame_period` and recovers within two seconds on its own.
            //
            // The outcome is logged rather than discarded. An earlier attempt set this in the block
            // above, before `SetOutputType`, where an MFT rejects it: with the error swallowed by
            // `let _ =`, that read exactly like a working fix and cost a whole build-and-test round to
            // disprove. If a driver refuses it here, that has to be visible.
            if let Some(api) = &codec_api {
                // Zero B-frames. A no-op under Constrained Baseline, which has none, and set anyway
                // because it is the other half of making a higher profile safe: B-frames are the
                // part that would add reordering latency to a live share, and they are separable
                // from the CABAC and 8x8 transform that are worth having. Kept so that turning the
                // profile above back on stays one line rather than two, and so the reasoning does
                // not have to be rediscovered. A refusal is logged for the same reason.
                if let Err(e) = api.SetValue(&CODECAPI_AVEncMPVDefaultBPictureCount, &0i32.into()) {
                    eprintln!(
                        "[publisher] this encoder refused a zero B-frame count ({e}); High profile \
                         may add reordering latency to the share"
                    );
                }

                let gop = spec.fps.max(1).saturating_mul(2);
                match api.SetValue(&CODECAPI_AVEncMPVGOPSize, &gop.into()) {
                    Ok(()) => eprintln!("[publisher] keyframe interval set to {gop} frames"),
                    Err(e) => eprintln!(
                        "[publisher] this encoder refused a {gop}-frame keyframe interval ({e}); \
                         viewers who join mid-share may see nothing until it emits an IDR of its own"
                    ),
                }
            }

            let input = MFCreateMediaType().map_err(|e| e.to_string())?;
            input
                .SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)
                .and_then(|_| input.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12))
                .and_then(|_| input.SetUINT64(&MF_MT_FRAME_SIZE, pack(spec.width, spec.height)))
                .and_then(|_| input.SetUINT64(&MF_MT_FRAME_RATE, pack(spec.fps.max(1), 1)))
                .and_then(|_| input.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pack(1, 1)))
                .and_then(|_| {
                    input.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)
                })
                // Signal BT.709 explicitly to match the conversion in `nv12`; unsignalled, a decoder
                // may assume BT.601 and render the stream with shifted colour.
                .and_then(|_| {
                    input.SetUINT32(&MF_MT_YUV_MATRIX, MFVideoTransferMatrix_BT709.0 as u32)
                })
                .map_err(|e| e.to_string())?;
            transform
                .SetInputType(0, &input, 0)
                .map_err(|e| format!("SetInputType failed: {e}"))?;

        Ok(())
    }

    /// Point an existing encoder at a new resolution, bitrate or frame rate.
    ///
    /// This exists instead of building a second encoder. Tearing a used NVIDIA MFT down faults on
    /// the driver's own RTWorkQ thread - `RTWorkQ -> nvEncMFTH264x -> ntdll`, a write into a
    /// critical section that has already been freed - and no ordering of DRAIN, FLUSH,
    /// END_STREAMING or ShutdownObject avoids it, because the object is released either way. The
    /// same crash is Mozilla bug 1754511, which they never fixed and worked around by not encoding
    /// in that process at all.
    ///
    /// A retype has to happen with the transform out of streaming mode, and the input type has to
    /// be cleared before the output type will move: an encoder MFT derives what input it accepts
    /// from the output it has been asked to produce.
    ///
    /// <p>Named `retype` rather than `reconfigure` so it does not shadow
    /// [`VideoEncoder::reconfigure`], which delegates here. Two methods of the same name on one
    /// type - one inherent, one from a trait - resolve by a priority rule rather than by anything
    /// visible at the call site, and this is called from both inside and outside the impl.</p>
    pub fn retype(&mut self, spec: EncoderSpec) -> Result<(), String> {
        if spec == self.spec {
            return Ok(());
        }
        if spec.width % 2 != 0 || spec.height % 2 != 0 || spec.width == 0 || spec.height == 0 {
            return Err(format!("{}x{} is not encodable", spec.width, spec.height));
        }

        unsafe {
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
            let _ = self
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let _ = self
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);

            // Whatever the transform had posted describes frames at the old geometry.
            if let Some(events) = self.events.clone() {
                while events.GetEvent(MF_EVENT_FLAG_NO_WAIT).is_ok() {}
            }

            self.transform
                .SetInputType(0, None, 0)
                .map_err(|e| format!("could not clear the input type: {e}"))?;
            Self::apply_spec(&self.transform, self.codec_api.as_ref(), spec)?;

            self.transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)
                .and_then(|_| {
                    self.transform
                        .ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0)
                })
                .map_err(|e| format!("failed to restart streaming: {e}"))?;
        }

        // Frames still queued describe the old geometry and would be paired with the wrong
        // timestamps, so they go with the configuration that produced them.
        self.pending.clear();
        self.inflight.clear();
        self.spec = spec;
        Ok(())
    }

    unsafe fn configure(
        activate: IMFActivate,
        transform: IMFTransform,
        spec: EncoderSpec,
    ) -> Result<Self, String> {
        let attributes = transform.GetAttributes().map_err(|e| e.to_string())?;
        let is_async = attributes.GetUINT32(&MF_TRANSFORM_ASYNC).unwrap_or(0) == 1;
        if is_async {
            // Required handshake: an async MFT refuses every other call until unlocked.
            attributes
                .SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1)
                .map_err(|e| e.to_string())?;
        }

        let codec_api: Option<ICodecAPI> = transform.cast().ok();
        Self::apply_spec(&transform, codec_api.as_ref(), spec)?;

        let events: Option<IMFMediaEventGenerator> = if is_async {
            Some(transform.cast().map_err(|e| e.to_string())?)
        } else {
            None
        };

        transform
            .ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0)
            .and_then(|_| transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0))
            .map_err(|e| format!("failed to start streaming: {e}"))?;

        Ok(Self {
            activate,
            transform,
            events,
            codec_api,
            spec,
            nv12_buf: Vec::with_capacity(nv12::buffer_len(spec.width, spec.height)),
            device_manager: None,
            pending: VecDeque::new(),
            inflight: VecDeque::new(),
        })
    }

    /// Point the transform at the device its input textures live on.
    ///
    /// Required before an MFT that reports `MF_SA_D3D11_AWARE` will accept a DXGI-backed sample.
    /// Without it the driver assumes system memory and rejects the buffer, so this failing is what
    /// sends `session::start` back to the CPU pipeline.
    pub(crate) fn bind_to_device(&mut self, device: &ID3D11Device) -> Result<(), String> {
        let aware = unsafe { self.transform.GetAttributes() }
            .ok()
            .and_then(|a| unsafe { a.GetUINT32(&MF_SA_D3D11_AWARE) }.ok())
            .unwrap_or(0);
        if aware != 1 {
            return Err("this encoder does not take D3D11 textures".into());
        }

        let mut token = 0u32;
        let mut manager: Option<IMFDXGIDeviceManager> = None;
        unsafe { MFCreateDXGIDeviceManager(&mut token, &mut manager) }
            .map_err(|e| format!("no DXGI device manager: {e}"))?;
        let manager = manager.ok_or("MFCreateDXGIDeviceManager returned nothing")?;
        unsafe { manager.ResetDevice(device, token) }
            .map_err(|e| format!("the device manager refused the device: {e}"))?;

        // The message takes the manager as a bare pointer-sized value. The transform holds its own
        // reference for as long as it needs one, and `manager` is kept alive here regardless.
        unsafe {
            self.transform
                .ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, manager.as_raw() as usize)
        }
        .map_err(|e| format!("the encoder refused a D3D manager: {e}"))?;

        self.device_manager = Some(manager);
        Ok(())
    }

    /// Whether this encoder is taking textures rather than CPU buffers.
    pub(crate) fn is_gpu_bound(&self) -> bool {
        self.device_manager.is_some()
    }

    /// Wrap an NV12 texture in an `IMFSample`, with no copy anywhere.
    ///
    /// The texture is already at this encoder's exact geometry, produced by the video processor,
    /// so there is nothing to convert and nothing to upload.
    unsafe fn build_texture_sample(
        &mut self,
        texture: &ID3D11Texture2D,
        timestamp_us: u64,
    ) -> Result<IMFSample, String> {
        let buffer = MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, texture, 0, false)
            .map_err(|e| format!("could not wrap the texture: {e}"))?;
        // A DXGI buffer reports its own length only after this is asked for; without it the
        // transform sees a zero-length buffer and skips the frame.
        let length = buffer
            .cast::<IMF2DBuffer>()
            .ok()
            .and_then(|two_d| two_d.GetContiguousLength().ok())
            .unwrap_or(0);
        if length > 0 {
            let _ = buffer.SetCurrentLength(length);
        }
        self.finish_sample(buffer, timestamp_us)
    }

    /// Wrap the converted frame in an `IMFSample` with timing information.
    unsafe fn build_sample(&mut self, frame: &RgbaImage, timestamp_us: u64) -> Result<IMFSample, String> {
        nv12::convert(frame, &mut self.nv12_buf);

        let buffer = MFCreateMemoryBuffer(self.nv12_buf.len() as u32).map_err(|e| e.to_string())?;
        let mut dst: *mut u8 = std::ptr::null_mut();
        buffer
            .Lock(&mut dst, None, None)
            .map_err(|e| e.to_string())?;
        std::ptr::copy_nonoverlapping(self.nv12_buf.as_ptr(), dst, self.nv12_buf.len());
        buffer.Unlock().map_err(|e| e.to_string())?;
        buffer
            .SetCurrentLength(self.nv12_buf.len() as u32)
            .map_err(|e| e.to_string())?;

        self.finish_sample(buffer, timestamp_us)
    }

    /// Put one buffer into a timed sample. Shared by the CPU and texture paths so a frame is
    /// timestamped identically whichever produced it.
    unsafe fn finish_sample(
        &self,
        buffer: IMFMediaBuffer,
        timestamp_us: u64,
    ) -> Result<IMFSample, String> {
        let sample = MFCreateSample().map_err(|e| e.to_string())?;
        sample.AddBuffer(&buffer).map_err(|e| e.to_string())?;
        // MF timestamps are in 100 ns units.
        sample
            .SetSampleTime((timestamp_us * 10) as i64)
            .map_err(|e| e.to_string())?;
        sample
            .SetSampleDuration((10_000_000 / self.spec.fps.max(1) as i64).max(1))
            .map_err(|e| e.to_string())?;
        Ok(sample)
    }

    /// Pull one encoded frame out of the transform, if it has one ready.
    unsafe fn collect_output(&mut self) -> Result<(), String> {
        let mut buffers = [MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: 0,
            pSample: ManuallyDrop::new(None),
            dwStatus: 0,
            pEvents: ManuallyDrop::new(None),
        }];
        let mut status = 0u32;

        self.transform
            .ProcessOutput(0, &mut buffers, &mut status)
            .map_err(|e| e.to_string())?;

        let sample = ManuallyDrop::take(&mut buffers[0].pSample);
        let Some(sample) = sample else {
            return Ok(());
        };

        let is_keyframe = sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) == 1;
        let buffer = sample.ConvertToContiguousBuffer().map_err(|e| e.to_string())?;

        let mut src: *mut u8 = std::ptr::null_mut();
        let mut len = 0u32;
        buffer
            .Lock(&mut src, None, Some(&mut len))
            .map_err(|e| e.to_string())?;
        let data = std::slice::from_raw_parts(src, len as usize).to_vec();
        let _ = buffer.Unlock();

        if !data.is_empty() {
            // Output order matches submission order for Constrained Baseline (no B-frames means no
            // reordering), so the oldest in-flight timestamp belongs to this frame.
            let timestamp_us = self
                .inflight
                .pop_front()
                .unwrap_or_else(|| sample.GetSampleTime().unwrap_or(0) as u64 / 10);
            self.pending.push_back(EncodedChunk {
                data,
                is_keyframe,
                timestamp_us,
            });
        }
        Ok(())
    }

    /// Synchronous transforms: feed a frame, then drain whatever comes back.
    unsafe fn encode_sync(&mut self, sample: &IMFSample, timestamp_us: u64) -> EncodeOutcome {
        if let Err(e) = self.transform.ProcessInput(0, sample, 0) {
            eprintln!("[publisher] {}x{}: sync ProcessInput failed: {e}", self.spec.width, self.spec.height);
            return EncodeOutcome::Failed;
        }
        self.inflight.push_back(timestamp_us);
        // MF_E_TRANSFORM_NEED_MORE_INPUT is the normal "still filling the pipeline" response, not
        // a fault, so a failure here only means nothing is ready yet.
        while self.collect_output().is_ok() {
            if self.pending.is_empty() {
                break;
            }
        }
        self.take_pending()
    }

    /// Asynchronous transforms: input and output are both driven by events.
    unsafe fn encode_async(&mut self, sample: &IMFSample, timestamp_us: u64) -> EncodeOutcome {
        let Some(events) = self.events.clone() else {
            eprintln!("[publisher] {}x{}: an async transform with no event generator", self.spec.width, self.spec.height);
            return EncodeOutcome::Failed;
        };

        let deadline = Instant::now() + FRAME_DEADLINE;
        let mut delivered = false;

        while Instant::now() < deadline {
            let Ok(event) = events.GetEvent(MF_EVENT_FLAG_NO_WAIT) else {
                // No event pending. If the frame is already in, there is nothing to wait for.
                if delivered {
                    break;
                }
                std::thread::sleep(Duration::from_micros(200));
                continue;
            };

            match event.GetType().unwrap_or(0) {
                x if x == METransformNeedInput.0 as u32 => {
                    if delivered {
                        // The encoder wants another frame; the next call will supply it.
                        break;
                    }
                    if let Err(e) = self.transform.ProcessInput(0, sample, 0) {
                        eprintln!("[publisher] {}x{}: async ProcessInput failed: {e}", self.spec.width, self.spec.height);
                        return EncodeOutcome::Failed;
                    }
                    self.inflight.push_back(timestamp_us);
                    delivered = true;
                }
                x if x == METransformHaveOutput.0 as u32 => {
                    if let Err(e) = self.collect_output() {
                        eprintln!("[publisher] {}x{}: collect_output failed: {e}", self.spec.width, self.spec.height);
                        return EncodeOutcome::Failed;
                    }
                }
                _ => {}
            }
        }

        if !delivered {
            // The transform never asked for input within the deadline: it is wedged.
            return EncodeOutcome::Failed;
        }
        self.take_pending()
    }

    fn take_pending(&mut self) -> EncodeOutcome {
        match self.pending.pop_front() {
            Some(chunk) => EncodeOutcome::Chunk(chunk),
            // Pipelined encoders legitimately produce nothing for the first few frames.
            None => EncodeOutcome::Skipped,
        }
    }
}

impl VideoEncoder for MediaFoundationEncoder {
    fn encode(&mut self, frame: CapturedFrame<'_>, timestamp_us: u64) -> EncodeOutcome {
        unsafe {
            let sample = match frame {
                CapturedFrame::Cpu(frame) => {
                    if frame.width() != self.spec.width || frame.height() != self.spec.height {
                        // Named rather than silent. This is the one failure here that is a *caller*
                        // fault rather than a driver one - the pump fitted the frame to a geometry
                        // the encoder was not built for - and telling those apart from a log is
                        // the difference between fixing the pump and blaming the GPU.
                        eprintln!(
                            "[publisher] frame {}x{} does not match the encoder built for {}x{}",
                            frame.width(),
                            frame.height(),
                            self.spec.width,
                            self.spec.height
                        );
                        return EncodeOutcome::Failed;
                    }
                    self.build_sample(frame, timestamp_us)
                }
                CapturedFrame::Gpu(texture) => {
                    if self.device_manager.is_none() {
                        eprintln!("[publisher] a texture reached an encoder with no D3D manager");
                        return EncodeOutcome::Failed;
                    }
                    self.build_texture_sample(texture, timestamp_us)
                }
            };

            let sample = match sample {
                Ok(sample) => sample,
                Err(e) => {
                    eprintln!("[publisher] failed to build an input sample: {e}");
                    return EncodeOutcome::Failed;
                }
            };

            if self.events.is_some() {
                self.encode_async(&sample, timestamp_us)
            } else {
                self.encode_sync(&sample, timestamp_us)
            }
        }
    }

    fn request_keyframe(&mut self) {
        if let Some(api) = &self.codec_api {
            unsafe {
                let _ = api.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &1u32.into());
            }
        }
    }

    fn reconfigure(&mut self, spec: EncoderSpec) -> Result<(), String> {
        self.retype(spec)
    }

    fn name(&self) -> &'static str {
        "media-foundation"
    }
}

impl Drop for MediaFoundationEncoder {
    fn drop(&mut self) {
        unsafe {
            // Drain and *wait for the transform to say it has finished* before shutting it down.
            //
            // A hardware MFT is asynchronous in a stronger sense than "output arrives later": the
            // driver runs its own work items on MF's real-time work queue, on threads we never see.
            // Tearing the object down while those are in flight is what faulted - captured stack,
            // on a thread that was not ours:
            //
            //     RTWorkQ.DLL -> nvEncMFTH264x.dll -> ntdll heap, write of 0x24
            //
            // The driver's worker was still completing into an object we had already shut down.
            // Firing FLUSH and immediately calling ShutdownObject does not help, because none of
            // those messages is a barrier - it only narrows the window, which is why the fault
            // moved from round 12 to round 42 rather than going away.
            //
            // METransformDrainComplete is the barrier. It is the MFT telling us its queues are
            // empty and its work items are done, and it is the only point at which shutting the
            // object down is safe.
            let _ = self
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0);

            if let Some(events) = self.events.clone() {
                let deadline = Instant::now() + DRAIN_DEADLINE;
                let mut drained = false;
                while Instant::now() < deadline {
                    let Ok(event) = events.GetEvent(MF_EVENT_FLAG_NO_WAIT) else {
                        std::thread::sleep(Duration::from_micros(200));
                        continue;
                    };
                    match event.GetType().unwrap_or(0) {
                        // Collected rather than ignored: each one holds a sample, and releasing
                        // them through the transform is tidier than leaving them for the shutdown.
                        x if x == METransformHaveOutput.0 as u32 => {
                            let _ = self.collect_output();
                        }
                        x if x == METransformDrainComplete.0 as u32 => {
                            drained = true;
                            break;
                        }
                        _ => {}
                    }
                }
                if !drained {
                    // A transform that will not drain is already wedged. Flush is the blunter
                    // instrument and at least tells it to abandon what it is holding.
                    eprintln!("[publisher] the encoder did not drain; flushing instead");
                    let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
                }
            }

            let _ = self
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);

            // Last, so the transform is idle and its queues are empty before the backing object
            // goes. This is what returns the encode session to the driver; releasing the interface
            // alone does not, and the next publish would find the encoder still in use.
            let _ = self.activate.ShutdownObject();
        }
    }
}

/// The display name of an encoder MFT, for the log.
unsafe fn friendly_name(activate: &IMFActivate) -> String {
    let mut text = windows::core::PWSTR::null();
    let mut len = 0u32;
    if activate
        .GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut text, &mut len)
        .is_err()
    {
        return "<unnamed encoder>".to_owned();
    }
    let name = String::from_utf16_lossy(std::slice::from_raw_parts(text.0, len as usize));
    windows::Win32::System::Com::CoTaskMemFree(Some(text.0 as *const _));
    name
}

/// Every hardware H.264 encoder MF knows about, best first, as activation objects only.
///
/// Deliberately *not* activated here. Activating an MFT takes an encode session from the driver,
/// and this used to hand back live transforms for every encoder on the machine - three of them
/// here - so that configuring the first one and returning left the other two activated and
/// abandoned. They were released but never `ShutdownObject`ed, which is not the same thing: only
/// the shutdown gives the session back. Each construction leaked two, and construction is what
/// changing the share resolution does, so the sessions accumulated until the driver fell over
/// inside its own heap.
///
/// The caller activates them one at a time and shuts down any it does not keep, so an encoder is
/// only ever created if it is about to be tried.
unsafe fn enumerate_hardware_encoders() -> Vec<IMFActivate> {
    let output = MFT_REGISTER_TYPE_INFO {
        guidMajorType: MFMediaType_Video,
        guidSubtype: MFVideoFormat_H264,
    };

    let mut activates: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count = 0u32;

    // SORTANDFILTER puts the preferred device first and drops ones that cannot be used.
    if MFTEnumEx(
        MFT_CATEGORY_VIDEO_ENCODER,
        MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
        None,
        Some(&output),
        &mut activates,
        &mut count,
    )
    .is_err()
    {
        return Vec::new();
    }

    let mut found = Vec::new();
    for i in 0..count as usize {
        if let Some(activate) = (*activates.add(i)).take() {
            found.push(activate);
        }
    }
    windows::Win32::System::Com::CoTaskMemFree(Some(activates as *const _));
    found
}


/// The one hardware encoder this process ever builds, parked here between shares.
///
/// It is never dropped. Destroying a used NVIDIA MFT faults inside the driver's own work queue -
/// `RTWorkQ -> nvEncMFTH264x -> ntdll`, a write into a critical section that has already been
/// freed - and no ordering of DRAIN, FLUSH, END_STREAMING or ShutdownObject prevents it, because
/// the object is released either way. Measured: rebuilding per resolution faulted within 3 to 42
/// rounds, while retyping one encoder in place survived 100 with no fault at all.
///
/// The same crash is Mozilla bug 1754511, which was never fixed upstream and which Firefox worked
/// around by not encoding in that process at all.
///
/// Keeping it also sidesteps NVIDIA's session limit, which this machine reports at twelve: past it
/// `SetOutputType` fails with 0xC00D6D76 and enumeration quietly falls through to another vendor's
/// encoder, so an implementation that leaked sessions would silently stop using the GPU it chose.
/// How many encoders may sit parked between shares.
///
/// One per rid of a full simulcast ladder. Parking the whole ladder is what turns the second share
/// of a session into three retypes rather than three fresh Media Foundation sessions, which matters
/// because the driver's session count is the scarce resource here - this machine reports twelve.
pub(crate) const PARK_CAPACITY: usize = super::simulcast::LAYER_RIDS.len();

static PARKED: OnceLock<Mutex<Vec<MediaFoundationEncoder>>> = OnceLock::new();

pub(crate) fn parked() -> &'static Mutex<Vec<MediaFoundationEncoder>> {
    PARKED.get_or_init(|| Mutex::new(Vec::new()))
}

/// A hardware encoder on loan from [`PARKED`], returned rather than destroyed when the share ends.
///
/// This is what the rest of the publisher sees, so nothing outside this module has to know that the
/// encoder outlives the session using it.
pub struct PooledEncoder(Option<MediaFoundationEncoder>);

impl PooledEncoder {
    /// A parked encoder retyped for `spec`, or a fresh one when none can be reused.
    pub fn acquire(spec: EncoderSpec) -> Option<Self> {
        if let Ok(mut slots) = parked().lock() {
            while let Some(mut encoder) = slots.pop() {
                match encoder.retype(spec) {
                    Ok(()) => return Some(Self(Some(encoder))),
                    Err(e) => {
                        // A transform that refused a retype is in an unknown state, and destroying
                        // it is the one outcome known to crash - so it leaves the pool without
                        // being dropped in the Rust sense, and the next parked one is tried. It
                        // used to be parked again, which left a permanently poisoned slot that
                        // every later acquire tried first and failed on before building anyway.
                        eprintln!("[publisher] a parked encoder refused a retype ({e}); retiring it");
                        std::mem::forget(encoder);
                    }
                }
            }
        }
        MediaFoundationEncoder::new(spec).map(|e| Self(Some(e)))
    }
}

impl PooledEncoder {
    /// Point the pooled transform at the device its input textures live on.
    ///
    /// Fails on a transform that is not `MF_SA_D3D11_AWARE` or whose driver refuses the manager,
    /// which is what sends `session::start` back to the CPU pipeline for the whole share.
    pub fn bind_to_device(&mut self, device: &ID3D11Device) -> Result<(), String> {
        match self.0.as_mut() {
            Some(encoder) => encoder.bind_to_device(device),
            None => Err("the pooled encoder is gone".into()),
        }
    }

    /// Whether this encoder is taking textures rather than CPU buffers.
    pub fn is_gpu_bound(&self) -> bool {
        self.0.as_ref().is_some_and(|encoder| encoder.is_gpu_bound())
    }
}

impl VideoEncoder for PooledEncoder {
    fn encode(&mut self, frame: CapturedFrame<'_>, timestamp_us: u64) -> EncodeOutcome {
        match self.0.as_mut() {
            Some(encoder) => encoder.encode(frame, timestamp_us),
            None => EncodeOutcome::Failed,
        }
    }

    fn request_keyframe(&mut self) {
        if let Some(encoder) = self.0.as_mut() {
            encoder.request_keyframe();
        }
    }

    /// The same retype [`PooledEncoder::acquire`] performs between shares, now reachable while one
    /// is running - which is what turns a resolution change into something the wire never notices.
    fn reconfigure(&mut self, spec: EncoderSpec) -> Result<(), String> {
        match self.0.as_mut() {
            Some(encoder) => encoder.retype(spec),
            None => Err("the pooled encoder is gone".into()),
        }
    }

    fn name(&self) -> &'static str {
        "media-foundation"
    }
}

impl Drop for PooledEncoder {
    fn drop(&mut self) {
        let Some(encoder) = self.0.take() else { return };
        match parked().lock() {
            // Parked, not destroyed. This is the whole point of the type.
            Ok(mut slots) if slots.len() < PARK_CAPACITY => slots.push(encoder),
            // The pool is full, or its lock is poisoned. Letting this one drop would run exactly
            // the teardown that crashes inside the driver - so it is leaked deliberately. Bounded
            // by how often more than a ladder's worth exist at once, which is ~never.
            _ => {
                eprintln!("[publisher] a spare hardware encoder is being retained rather than destroyed");
                std::mem::forget(encoder);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The defect the content mode was added to fix: every share was encoded CBR, which on a screen
    /// that holds still spends the budget on frames nobody needed.
    #[test]
    fn text_is_not_encoded_at_a_constant_bitrate() {
        let plan = RatePlan::for_spec(spec(1280, 720));
        assert_eq!(plan.mode, eAVEncCommonRateControlMode_PeakConstrainedVBR.0 as u32);
        assert_ne!(plan.mode, eAVEncCommonRateControlMode_CBR.0 as u32);
        // A ceiling above the mean is the whole point: without it the mode is VBR in name only.
        assert_eq!(plan.peak_bps, Some(plan.mean_bps * 2));
        assert_eq!(plan.quality_vs_speed, Some(70));
    }

    #[test]
    fn games_stays_on_constant_bitrate_with_no_ceiling_of_its_own() {
        let plan = RatePlan::for_spec(EncoderSpec {
            content: EncoderContent::Games,
            ..spec(1280, 720)
        });
        assert_eq!(plan.mode, eAVEncCommonRateControlMode_CBR.0 as u32);
        assert_eq!(plan.peak_bps, None);
        assert_eq!(plan.quality_vs_speed, None);
    }

    /// Neither mode may change the budget - that is the preset's decision, not the encoder's.
    #[test]
    fn the_mean_bitrate_is_the_presets_own_in_both_modes() {
        let text = RatePlan::for_spec(spec(1280, 720));
        let games = RatePlan::for_spec(EncoderSpec {
            content: EncoderContent::Games,
            ..spec(1280, 720)
        });
        assert_eq!(text.mean_bps, games.mean_bps);
        assert_eq!(text.mean_bps, spec(1280, 720).kbps * 1000);
    }

    /// Three encoders at once, which is what a full simulcast ladder holds.
    ///
    /// Hardware-dependent like every other test in this file: CI containers and VMs have no encoder
    /// and skip. Where one exists, three must coexist - the single-slot pool this replaced would
    /// have leaked two of them on drop, into a driver session limit of about twelve.
    #[test]
    fn holds_a_whole_ladder_at_once() {
        let Some(top) = PooledEncoder::acquire(spec(1920, 1080)) else {
            eprintln!("no hardware H.264 encoder on this machine; skipping");
            return;
        };
        let middle = PooledEncoder::acquire(spec(960, 540));
        let bottom = PooledEncoder::acquire(spec(480, 270));

        assert!(middle.is_some(), "the pool refused a second encoder");
        assert!(bottom.is_some(), "the pool refused a third encoder");

        drop(top);
        drop(middle);
        drop(bottom);

        // Parked rather than leaked, so the next share reuses them instead of opening three more
        // sessions against the driver's limit.
        assert!(parked().lock().map(|s| s.len()).unwrap_or(0) <= PARK_CAPACITY);
    }

    /// Parking is bounded. Encoders beyond a ladder's worth must not grow the pool without limit.
    #[test]
    fn parks_no_more_than_a_ladder_of_encoders() {
        let Some(first) = PooledEncoder::acquire(spec(640, 360)) else {
            eprintln!("no hardware H.264 encoder on this machine; skipping");
            return;
        };
        let held: Vec<_> = (0..PARK_CAPACITY + 1)
            .filter_map(|_| PooledEncoder::acquire(spec(640, 360)))
            .collect();
        drop(first);
        drop(held);

        assert!(parked().lock().map(|s| s.len()).unwrap_or(0) <= PARK_CAPACITY);
    }

    fn spec(width: u32, height: u32) -> EncoderSpec {
        EncoderSpec {
            width,
            height,
            fps: 30,
            kbps: 4000,
            content: EncoderContent::Text,
        }
    }

    fn frame(width: u32, height: u32, shift: u32) -> RgbaImage {
        RgbaImage::from_fn(width, height, |x, y| {
            let v = (((x + shift) / 8 + y / 8) % 2) as u8;
            image::Rgba([v * 255, (x % 256) as u8, (y % 256) as u8, 255])
        })
    }

    #[test]
    fn rejects_odd_geometry() {
        // H.264 4:2:0 cannot represent an odd edge; accepting it would corrupt chroma.
        assert!(PooledEncoder::acquire(spec(1921, 1080)).is_none());
        assert!(PooledEncoder::acquire(spec(1920, 1081)).is_none());
        assert!(PooledEncoder::acquire(spec(0, 0)).is_none());
    }

    /// Hardware encoding is machine-dependent: CI containers and VMs have no encoder, and that is
    /// a legitimate configuration rather than a failure. Where one exists, it must actually work.
    #[test]
    fn produces_annex_b_when_hardware_is_present() {
        let Some(mut encoder) = PooledEncoder::acquire(spec(640, 360)) else {
            eprintln!("no hardware H.264 encoder on this machine; skipping");
            return;
        };

        // Pipelined encoders emit nothing for the first frames, so feed a short run.
        let mut chunks = Vec::new();
        for i in 0..30u64 {
            if let EncodeOutcome::Chunk(chunk) = encoder.encode(CapturedFrame::Cpu(&frame(640, 360, i as u32)), i * 33_333) {
                chunks.push(chunk);
            }
        }

        assert!(!chunks.is_empty(), "hardware encoder produced no output over 30 frames");
        let first = &chunks[0];
        assert!(first.data.len() > 4);
        assert_eq!(
            &first.data[0..4],
            &[0, 0, 0, 1],
            "expected an Annex-B start code, got {:?}",
            &first.data[0..4.min(first.data.len())]
        );
        assert!(chunks.iter().any(|c| c.is_keyframe), "no keyframe in the first 30 frames");
    }

    #[test]
    fn rejects_a_frame_that_does_not_match_its_geometry() {
        let Some(mut encoder) = PooledEncoder::acquire(spec(640, 360)) else {
            return;
        };
        // Geometry is fixed for the session; a mismatch is a broken contract, not a skip.
        assert!(matches!(
            encoder.encode(CapturedFrame::Cpu(&frame(320, 240, 0)), 0),
            EncodeOutcome::Failed
        ));
    }
}

#[cfg(test)]
mod probe {
    use super::*;

    fn frame(width: u32, height: u32, shift: u32) -> RgbaImage {
        RgbaImage::from_fn(width, height, |x, y| {
            let v = (((x + shift) / 8 + y / 8) % 2) as u8;
            image::Rgba([v * 255, (x % 256) as u8, (y % 256) as u8, 255])
        })
    }

    /// Reports what this machine offers. Not an assertion - a diagnostic, so a failing hardware
    /// test can be told apart from a machine that simply has no encoder.
    #[test]
    fn report_available_hardware_encoders() {
        assert!(ensure_mf_started(), "Media Foundation failed to start");
        let count = unsafe { enumerate_hardware_encoders() }.len();
        eprintln!("[probe] hardware H.264 encoder MFTs found: {count}");
        let built = PooledEncoder::acquire(EncoderSpec {
            width: 640,
            height: 360,
            fps: 30,
            kbps: 4000,
            content: EncoderContent::Text,
        });
        eprintln!("[probe] encoder constructed: {}", built.is_some());
    }

    /// Whether the encoders on this machine will take a GPU texture instead of a CPU buffer.
    ///
    /// The one fact the whole zero-copy question turns on. An MFT that reports `MF_SA_D3D11_AWARE`
    /// can be handed a `Direct3D11CaptureFrame`'s texture through `MFCreateDXGISurfaceBuffer`, and
    /// the RGBA download, the scale, the NV12 conversion and the upload all stop existing.
    #[test]
    fn report_whether_the_encoders_take_gpu_textures() {
        assert!(ensure_mf_started(), "Media Foundation failed to start");

        for activate in unsafe { enumerate_hardware_encoders() } {
            let name = unsafe { friendly_name(&activate) };
            let Ok(transform) = (unsafe { activate.ActivateObject::<IMFTransform>() }) else {
                eprintln!("[probe] {name}: would not activate");
                continue;
            };

            let attributes = unsafe { transform.GetAttributes() };
            let d3d11 = attributes
                .as_ref()
                .ok()
                .and_then(|a| unsafe { a.GetUINT32(&MF_SA_D3D11_AWARE) }.ok())
                .unwrap_or(0);
            let d3d9 = attributes
                .as_ref()
                .ok()
                .and_then(|a| unsafe { a.GetUINT32(&MF_SA_D3D_AWARE) }.ok())
                .unwrap_or(0);
            let async_mft = attributes
                .as_ref()
                .ok()
                .and_then(|a| unsafe { a.GetUINT32(&MF_TRANSFORM_ASYNC) }.ok())
                .unwrap_or(0);

            eprintln!(
                "[probe] {name}: MF_SA_D3D11_AWARE={d3d11} MF_SA_D3D_AWARE={d3d9} async={async_mft}"
            );

            // What the encoder will take on its input stream. NV12 is the CPU path we use today;
            // anything else here is what a GPU surface could be handed as.
            for index in 0..8u32 {
                match unsafe { transform.GetInputAvailableType(0, index) } {
                    Ok(media_type) => {
                        let subtype = unsafe { media_type.GetGUID(&MF_MT_SUBTYPE) };
                        eprintln!("[probe]   input type {index}: {subtype:?}");
                    }
                    Err(_) => break,
                }
            }

            unsafe {
                let _ = activate.ShutdownObject();
            }
        }
    }


    /// One encoder, the same total number of frames, never torn down until the end.
    ///
    /// The control for every teardown hypothesis. If this faults too, teardown is innocent and the
    /// fault is about encoding volume rather than about create/destroy.
    #[test]
    #[ignore = "diagnostic probe"]
    fn report_one_encoder_many_frames() {
        let (w, h) = (1280u32, 720u32);
        let Some(mut encoder) = MediaFoundationEncoder::new(EncoderSpec {
            width: w,
            height: h,
            fps: 30,
            kbps: 4000,
            content: EncoderContent::Text,
        }) else {
            eprintln!("[probe] no encoder");
            return;
        };
        let frames: Vec<RgbaImage> = (0..4).map(|i| frame(w, h, i * 7)).collect();
        for i in 0..6000u64 {
            let _ = encoder.encode(CapturedFrame::Cpu(&frames[i as usize % 4]), i * 33_333);
            if i % 1000 == 0 {
                eprintln!("[probe] {i} frames through one encoder");
            }
        }
        eprintln!("[probe] survived 6000 frames on one encoder");
    }

    /// Many encoders, each used, none ever dropped.
    ///
    /// The other control: if this faults, the fault is in construction or in having many live at
    /// once, and no amount of care at teardown can reach it.
    #[test]
    #[ignore = "diagnostic probe"]
    fn report_many_encoders_never_dropped() {
        let mut kept = Vec::new();
        for round in 0..100 {
            let (w, h) = if round % 2 == 0 { (1280u32, 720u32) } else { (1920, 1080) };
            let Some(mut encoder) = MediaFoundationEncoder::new(EncoderSpec {
                width: w,
                height: h,
                fps: 30,
                kbps: 4000,
                content: EncoderContent::Text,
            }) else {
                eprintln!("[probe] round {round}: no encoder would configure");
                break;
            };
            let frames: Vec<RgbaImage> = (0..2).map(|i| frame(w, h, i * 7)).collect();
            for i in 0..60u64 {
                let _ = encoder.encode(CapturedFrame::Cpu(&frames[i as usize % 2]), i * 33_333);
            }
            eprintln!("[probe] round {round}: {w}x{h} encoded, keeping it alive");
            kept.push(encoder);
        }
        eprintln!("[probe] survived {} live encoders", kept.len());
        std::mem::forget(kept);
    }

    /// One encoder, retyped between resolutions instead of rebuilt.
    ///
    /// The control this is measured against is `report_repeated_construction`, which does the same
    /// work by building a new encoder each round and faults inside the driver within a few dozen
    /// rounds. If a retype is accepted and this survives, a resolution change never has to destroy
    /// an encoder at all.
    #[test]
    #[ignore = "diagnostic probe"]
    fn report_retype_instead_of_rebuild() {
        let Some(mut encoder) = MediaFoundationEncoder::new(EncoderSpec {
            width: 1280,
            height: 720,
            fps: 30,
            kbps: 4000,
            content: EncoderContent::Text,
        }) else {
            eprintln!("[probe] no encoder");
            return;
        };

        for round in 0..100 {
            let (w, h) = if round % 2 == 0 { (1920u32, 1080u32) } else { (1280, 720) };
            if let Err(e) = encoder.reconfigure(EncoderSpec {
                width: w,
                height: h,
                fps: 30,
                kbps: 4000,
                content: EncoderContent::Text,
            }) {
                eprintln!("[probe] round {round}: retype to {w}x{h} REFUSED: {e}");
                return;
            }

            let frames: Vec<RgbaImage> = (0..2).map(|i| frame(w, h, i * 7)).collect();
            let mut out = 0usize;
            for i in 0..60u64 {
                if let EncodeOutcome::Chunk(_) = encoder.encode(CapturedFrame::Cpu(&frames[i as usize % 2]), i * 33_333) {
                    out += 1;
                }
            }
            eprintln!("[probe] round {round}: retyped to {w}x{h}, {out}/60 chunks");
        }
        eprintln!("[probe] survived 100 retypes on one encoder");
    }

    /// Repeated construct-encode-drop, which is what changing the share resolution does.
    ///
    /// The encoding is the point. An earlier version of this probe constructed and dropped 40
    /// encoders without feeding them a single frame and never once faulted - a transform with
    /// nothing in flight has nothing to race with when it is torn down.
    #[test]
    #[ignore = "diagnostic probe"]
    fn report_repeated_construction() {
        eprintln!("[probe] test runs on OS thread {}", unsafe {
            windows::Win32::System::Threading::GetCurrentThreadId()
        });
        for round in 0..100 {
            let (w, h) = if round % 2 == 0 { (1280u32, 720u32) } else { (1920, 1080) };
            let Some(mut encoder) = MediaFoundationEncoder::new(EncoderSpec {
                width: w,
                height: h,
                fps: 30,
                kbps: 4000,
                content: EncoderContent::Text,
            }) else {
                eprintln!("[probe] round {round}: no encoder");
                continue;
            };

            let frames: Vec<RgbaImage> = (0..4).map(|i| frame(w, h, i * 7)).collect();
            let mut out = 0usize;
            for i in 0..60u64 {
                if let EncodeOutcome::Chunk(_) = encoder.encode(CapturedFrame::Cpu(&frames[i as usize % 4]), i * 33_333) {
                    out += 1;
                }
            }
            eprintln!("[probe] round {round}: {w}x{h}, {out}/60 chunks, dropping with output in flight");
            drop(encoder);
        }
        eprintln!("[probe] survived 100 rounds");
    }

    /// What one frame costs at each resolution this client offers.
    ///
    /// The number that matters is the per-frame cost against the frame interval it has to fit
    /// inside - 33 ms at 30 fps, 16 ms at 60. A share whose encode alone exceeds that cannot reach
    /// its configured rate however healthy everything else is, and the capture thread does a
    /// full-frame resize and a periodic JPEG preview on top of what is measured here.
    ///
    /// Worth running in both profiles. Measured on one machine: 3.6 ms per 1080p frame built with
    /// `--release` against 73.8 ms for the same frame built with `cargo build`, a factor of 20 -
    /// which is the difference between a share comfortably holding 30 fps and one managing 13.
    /// `nv12::convert` is a scalar per-pixel loop and dominates that gap.
    #[test]
    fn report_the_cost_of_a_frame_at_each_resolution() {
        for (w, h) in [(1280u32, 720u32), (1920, 1080), (2560, 1440), (3840, 2160)] {
            // Through the pool, so the sweep retypes one encoder instead of building and
            // destroying four - which is the fault this module is built around.
            let Some(mut encoder) = PooledEncoder::acquire(EncoderSpec {
                width: w,
                height: h,
                fps: 30,
                kbps: 8000,
                content: EncoderContent::Text,
            }) else {
                eprintln!("[probe] {w}x{h}: no encoder would configure");
                continue;
            };

            let frames: Vec<RgbaImage> = (0..4).map(|i| frame(w, h, i * 7)).collect();
            let mut out = 0usize;
            let started = Instant::now();
            for i in 0..60u64 {
                if let EncodeOutcome::Chunk(_) = encoder.encode(CapturedFrame::Cpu(&frames[i as usize % 4]), i * 33_333)
                {
                    out += 1;
                }
            }
            let per_frame = started.elapsed().as_secs_f64() * 1000.0 / 60.0;
            eprintln!(
                "[probe] {w}x{h}: {per_frame:.1} ms/frame (ceiling {:.0} fps), {out}/60 chunks out",
                1000.0 / per_frame,
            );
        }
    }

}

#[cfg(test)]
mod ladder_diagnosis {
    use super::*;
    use crate::media::publisher::encoder::{EncodeOutcome, EncoderContent, EncoderSpec, VideoEncoder};
    use image::RgbaImage;

    /// The production ladder, verbatim from a real share:
    /// `f=1920x1080@16000k h=960x540@5120k q=480x270@1600k`.
    fn ladder() -> Vec<EncoderSpec> {
        [(1920u32, 1080u32, 16_000u32), (960, 540, 5_120), (480, 270, 1_600)]
            .into_iter()
            .map(|(width, height, kbps)| EncoderSpec {
                width,
                height,
                fps: 30,
                kbps,
                content: EncoderContent::Text,
            })
            .collect()
    }

    fn frame(width: u32, height: u32, shift: u32) -> RgbaImage {
        RgbaImage::from_fn(width, height, |x, y| {
            let v = (((x + shift) / 8 + y / 8) % 2) as u8;
            image::Rgba([v * 255, (x % 256) as u8, (y % 256) as u8, 255])
        })
    }

    /// Reports, per rung, whether the hardware encoder survives a run of frames.
    ///
    /// A *diagnosis*, not a guard: it prints and does not assert, because what it is here to answer
    /// is which rung fails and after how many frames. `ResilientEncoder` swaps to software after
    /// three consecutive failures, so in production the only symptom is one line per layer with no
    /// indication of which frame, which geometry, or which error.
    #[test]
    #[ignore = "diagnostic: runs the real Media Foundation encoder"]
    fn report_whether_the_production_ladder_survives() {
        for spec in ladder() {
            let Some(mut encoder) = PooledEncoder::acquire(spec) else {
                println!(
                    "LADDER {}x{}@{}k: no hardware encoder acquired at all",
                    spec.width, spec.height, spec.kbps
                );
                continue;
            };

            let mut chunks = 0u32;
            let mut first_failure: Option<u32> = None;
            for i in 0..90u64 {
                match encoder.encode(CapturedFrame::Cpu(&frame(spec.width, spec.height, i as u32)), i * 33_333) {
                    EncodeOutcome::Chunk(_) => chunks += 1,
                    // By design, not a fault - a pipelined encoder emits nothing for its first
                    // frames, so counting these as failures is how a healthy stream gets swapped
                    // out from under itself.
                    EncodeOutcome::Skipped => {}
                    EncodeOutcome::Failed => {
                        first_failure.get_or_insert(i as u32);
                    }
                }
            }

            match first_failure {
                None => println!(
                    "LADDER {}x{}@{}k: OK, {chunks} chunks over 90 frames",
                    spec.width, spec.height, spec.kbps
                ),
                Some(at) => println!(
                    "LADDER {}x{}@{}k: FAILED first at frame {at}, {chunks} chunks produced",
                    spec.width, spec.height, spec.kbps
                ),
            }
        }
    }
}

#[cfg(test)]
mod ladder_concurrency {
    use super::ladder_diagnosis::*;
    use super::*;
    use crate::media::publisher::encoder::{EncodeOutcome, EncoderContent, EncoderSpec, VideoEncoder};
    use image::RgbaImage;

    /// The rungs a 1440p source solves to, which is what the failing session was running.
    ///
    /// The 1080p ladder passes; this is the geometry the log showed when the encoder fell back
    /// (`now encoding at 2560x1440 (12000 kbps) across 3 layer(s)`). Three NVENC sessions at this
    /// size is materially more than three at 1080p, and High profile turns on B-frames here where
    /// Constrained Baseline had none - so both the session budget and the reordering are new.
    fn rungs_1440() -> Vec<EncoderSpec> {
        [(2560u32, 1440u32, 12_000u32), (1280, 720, 3_840), (640, 360, 1_200)]
            .into_iter()
            .map(|(width, height, kbps)| EncoderSpec {
                width,
                height,
                fps: 30,
                kbps,
                content: EncoderContent::Text,
            })
            .collect()
    }

    fn rungs() -> Vec<EncoderSpec> {
        [(1920u32, 1080u32, 16_000u32), (960, 540, 5_120), (480, 270, 1_600)]
            .into_iter()
            .map(|(width, height, kbps)| EncoderSpec {
                width,
                height,
                fps: 30,
                kbps,
                content: EncoderContent::Text,
            })
            .collect()
    }

    fn frame(width: u32, height: u32, shift: u32) -> RgbaImage {
        RgbaImage::from_fn(width, height, |x, y| {
            let v = (((x + shift) / 8 + y / 8) % 2) as u8;
            image::Rgba([v * 255, (x % 256) as u8, (y % 256) as u8, 255])
        })
    }

    /// The ladder as `FramePump` actually drives it: three encoders alive at once, each fed one
    /// frame per capture tick.
    ///
    /// This is the shape the sequential diagnosis does not reproduce. There, each encoder is built,
    /// drained and parked before the next exists, so at most one hardware session is live; in
    /// production all three hold a session simultaneously and are interleaved frame by frame.
    /// Retype *upward*, which is what the failing session actually did.
    ///
    /// The log shows the failures beginning immediately after `now encoding at 2560x1440`, on
    /// encoders that had been built for 1080p. Every other probe here retypes downward and back,
    /// never past the geometry the encoder was first allocated for - and a hardware encoder sizes
    /// its surfaces at construction, so growing one is the case none of them cover.
    /// 2K at **60**, which every other diagnostic here misses by running at 30.
    ///
    /// Level 5.2 permits it on paper - 1440p is 14400 macroblocks, so 60 fps is 864000 against a
    /// MaxMBPS of 2073600 - but what the hardware will actually sustain at that rate is a separate
    /// question from what the standard allows, and only one of the two is measurable here.
    #[test]
    #[ignore = "diagnostic: runs the real Media Foundation encoder"]
    fn report_whether_1440p60_survives() {
        let ladder = [
            (2560u32, 1440u32, 12_000u32),
            (1280, 720, 3_840),
            (640, 360, 1_200),
        ]
        .into_iter()
        .map(|(width, height, kbps)| EncoderSpec {
            width,
            height,
            fps: 60,
            kbps,
            content: EncoderContent::Text,
        })
        .collect::<Vec<_>>();

        let mut encoders = Vec::new();
        for spec in &ladder {
            match PooledEncoder::acquire(*spec) {
                Some(encoder) => encoders.push((*spec, encoder)),
                None => println!("1440p60 {}x{}: no hardware encoder", spec.width, spec.height),
            }
        }
        println!("1440p60 acquired {} of {} rungs", encoders.len(), ladder.len());

        let mut chunks = vec![0u32; encoders.len()];
        let mut first_failure: Vec<Option<u32>> = vec![None; encoders.len()];
        let started = std::time::Instant::now();

        // 180 frames is three seconds of 60 fps, long enough for rate control to settle.
        for i in 0..180u64 {
            for (index, (spec, encoder)) in encoders.iter_mut().enumerate() {
                match encoder.encode(CapturedFrame::Cpu(&frame(spec.width, spec.height, i as u32)), i * 16_667) {
                    EncodeOutcome::Chunk(_) => chunks[index] += 1,
                    EncodeOutcome::Skipped => {}
                    EncodeOutcome::Failed => {
                        first_failure[index].get_or_insert(i as u32);
                    }
                }
            }
        }
        let elapsed = started.elapsed();

        for (index, (spec, _)) in encoders.iter().enumerate() {
            match first_failure[index] {
                None => println!(
                    "1440p60 {}x{}@{}k: OK, {} chunks",
                    spec.width, spec.height, spec.kbps, chunks[index]
                ),
                Some(at) => println!(
                    "1440p60 {}x{}@{}k: FAILED first at frame {at}, {} chunks",
                    spec.width, spec.height, spec.kbps, chunks[index]
                ),
            }
        }
        // The whole ladder, 180 frames. Under 3s means it sustains 60 fps with headroom; over means
        // the encoder is the thing that caps the framerate, whatever the level permits.
        println!("1440p60 whole ladder: 180 frames in {elapsed:?}");
    }

    #[test]
    #[ignore = "diagnostic: runs the real Media Foundation encoder"]
    fn report_whether_retyping_upward_survives() {
        let small = EncoderSpec {
            width: 1920,
            height: 1080,
            fps: 30,
            kbps: 8_000,
            content: EncoderContent::Text,
        };
        let big = EncoderSpec {
            width: 2560,
            height: 1440,
            fps: 30,
            kbps: 12_000,
            content: EncoderContent::Text,
        };

        let Some(mut encoder) = PooledEncoder::acquire(small) else {
            println!("UPWARD: no hardware encoder");
            return;
        };

        let mut before = 0u32;
        for i in 0..30u64 {
            if let EncodeOutcome::Chunk(_) = encoder.encode(CapturedFrame::Cpu(&frame(small.width, small.height, i as u32)), i * 33_333) {
                before += 1;
            }
        }
        println!("UPWARD at 1920x1080: {before} chunks over 30 frames");

        match encoder.reconfigure(big) {
            Ok(()) => println!("UPWARD reconfigure to 2560x1440: accepted"),
            Err(e) => {
                println!("UPWARD reconfigure to 2560x1440: REFUSED: {e}");
                return;
            }
        }

        let mut after = 0u32;
        let mut first_failure: Option<u32> = None;
        for i in 30..90u64 {
            match encoder.encode(CapturedFrame::Cpu(&frame(big.width, big.height, i as u32)), i * 33_333) {
                EncodeOutcome::Chunk(_) => after += 1,
                EncodeOutcome::Skipped => {}
                EncodeOutcome::Failed => {
                    first_failure.get_or_insert(i as u32);
                }
            }
        }
        match first_failure {
            None => println!("UPWARD at 2560x1440: OK, {after} chunks over 60 frames"),
            Some(at) => println!("UPWARD at 2560x1440: FAILED first at frame {at}, {after} chunks"),
        }
    }

    #[test]
    #[ignore = "diagnostic: runs the real Media Foundation encoder"]
    fn report_whether_a_1440p_ladder_survives() {
        let specs = rungs_1440();
        let mut encoders = Vec::new();
        for spec in &specs {
            match PooledEncoder::acquire(*spec) {
                Some(encoder) => encoders.push((*spec, encoder)),
                None => println!(
                    "1440 {}x{}: could not acquire a hardware encoder at all",
                    spec.width, spec.height
                ),
            }
        }
        println!("1440 acquired {} of {} rungs", encoders.len(), specs.len());

        let mut chunks = vec![0u32; encoders.len()];
        let mut first_failure: Vec<Option<u32>> = vec![None; encoders.len()];

        for i in 0..90u64 {
            for (index, (spec, encoder)) in encoders.iter_mut().enumerate() {
                match encoder.encode(CapturedFrame::Cpu(&frame(spec.width, spec.height, i as u32)), i * 33_333) {
                    EncodeOutcome::Chunk(_) => chunks[index] += 1,
                    EncodeOutcome::Skipped => {}
                    EncodeOutcome::Failed => {
                        first_failure[index].get_or_insert(i as u32);
                    }
                }
            }
        }

        for (index, (spec, _)) in encoders.iter().enumerate() {
            match first_failure[index] {
                None => println!(
                    "1440 {}x{}@{}k: OK, {} chunks",
                    spec.width, spec.height, spec.kbps, chunks[index]
                ),
                Some(at) => println!(
                    "1440 {}x{}@{}k: FAILED first at frame {at}, {} chunks produced",
                    spec.width, spec.height, spec.kbps, chunks[index]
                ),
            }
        }
    }

    #[test]
    #[ignore = "diagnostic: runs the real Media Foundation encoder"]
    fn report_whether_a_concurrent_interleaved_ladder_survives() {
        let specs = rungs();
        let mut encoders = Vec::new();
        for spec in &specs {
            match PooledEncoder::acquire(*spec) {
                Some(encoder) => encoders.push((*spec, encoder)),
                None => println!(
                    "CONCURRENT {}x{}: could not acquire a hardware encoder at all",
                    spec.width, spec.height
                ),
            }
        }
        println!("CONCURRENT acquired {} of {} rungs", encoders.len(), specs.len());

        let mut chunks = vec![0u32; encoders.len()];
        let mut first_failure: Vec<Option<u32>> = vec![None; encoders.len()];

        for i in 0..90u64 {
            for (index, (spec, encoder)) in encoders.iter_mut().enumerate() {
                match encoder.encode(CapturedFrame::Cpu(&frame(spec.width, spec.height, i as u32)), i * 33_333) {
                    EncodeOutcome::Chunk(_) => chunks[index] += 1,
                    EncodeOutcome::Skipped => {}
                    EncodeOutcome::Failed => {
                        first_failure[index].get_or_insert(i as u32);
                    }
                }
            }
        }

        for (index, (spec, _)) in encoders.iter().enumerate() {
            match first_failure[index] {
                None => println!(
                    "CONCURRENT {}x{}@{}k: OK, {} chunks",
                    spec.width, spec.height, spec.kbps, chunks[index]
                ),
                Some(at) => println!(
                    "CONCURRENT {}x{}@{}k: FAILED first at frame {at}, {} chunks produced",
                    spec.width, spec.height, spec.kbps, chunks[index]
                ),
            }
        }
    }
}
