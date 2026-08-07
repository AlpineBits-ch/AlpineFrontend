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
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use image::RgbaImage;
use windows::core::Interface;
use windows::Win32::Media::MediaFoundation::*;

use super::encoder::{EncodeOutcome, EncodedChunk, EncoderSpec, VideoEncoder};
use super::nv12;

/// How long a single frame may spend waiting on the encoder before we give up on it.
///
/// Generous next to a frame interval (16 ms at 60 fps) but far below anything a user would notice
/// as a stall, so a wedged encoder is detected in a few frames rather than hanging capture.
const FRAME_DEADLINE: Duration = Duration::from_millis(100);

/// Media Foundation must be initialised once per process before any MF call.
static MF_STARTED: OnceLock<bool> = OnceLock::new();

fn ensure_mf_started() -> bool {
    *MF_STARTED.get_or_init(|| unsafe {
        // NOSOCKET: we only ever run transforms locally, never the network source.
        MFStartup(MF_VERSION, MFSTARTUP_NOSOCKET).is_ok()
    })
}

/// Pack two 32-bit values into the UINT64 layout MF uses for size and ratio attributes.
fn pack(high: u32, low: u32) -> u64 {
    ((high as u64) << 32) | low as u64
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
    nv12_buf: Vec<u8>,
    /// Output runs a few frames behind input, so completed frames queue here.
    pending: VecDeque<EncodedChunk>,
    /// Timestamps queued in submission order, to pair with output that arrives later.
    inflight: VecDeque<u64>,
}

// The transform is only ever touched from the single capture thread that owns the encoder.
unsafe impl Send for MediaFoundationEncoder {}

impl MediaFoundationEncoder {
    pub fn new(spec: EncoderSpec) -> Option<Self> {
        if spec.width % 2 != 0 || spec.height % 2 != 0 || spec.width == 0 || spec.height == 0 {
            return None;
        }
        if !ensure_mf_started() {
            return None;
        }

        for (activate, transform) in unsafe { enumerate_hardware_encoders() } {
            match unsafe { Self::configure(activate.clone(), transform, spec) } {
                Ok(encoder) => return Some(encoder),
                Err(e) => {
                    eprintln!("[publisher] a hardware encoder failed to configure: {e}");
                    // Released here rather than left to the drop below. An encoder we are not going
                    // to use must go back to the driver now, or the next publish finds it busy.
                    unsafe { let _ = activate.ShutdownObject(); }
                }
            }
        }
        None
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
        if let Some(api) = &codec_api {
            // Low latency matters more than compression efficiency for a live screen share: it
            // caps how many frames the encoder may hold before emitting one.
            let _ = api.SetValue(&CODECAPI_AVLowLatencyMode, &true.into());
            let _ = api.SetValue(
                &CODECAPI_AVEncCommonRateControlMode,
                &(eAVEncCommonRateControlMode_CBR.0 as u32).into(),
            );
            let _ = api.SetValue(
                &CODECAPI_AVEncCommonMeanBitRate,
                &(spec.kbps.saturating_mul(1000)).into(),
            );
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
            // Constrained Baseline: no B-frames, no CABAC, decodable by every browser. Higher
            // profiles would compress better but B-frames add reordering latency we do not want.
            .and_then(|_| {
                output.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_ConstrainedBase.0 as u32)
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
            pending: VecDeque::new(),
            inflight: VecDeque::new(),
        })
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
        if self.transform.ProcessInput(0, sample, 0).is_err() {
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
                    if self.transform.ProcessInput(0, sample, 0).is_err() {
                        return EncodeOutcome::Failed;
                    }
                    self.inflight.push_back(timestamp_us);
                    delivered = true;
                }
                x if x == METransformHaveOutput.0 as u32 => {
                    if self.collect_output().is_err() {
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
    fn encode(&mut self, frame: &RgbaImage, timestamp_us: u64) -> EncodeOutcome {
        if frame.width() != self.spec.width || frame.height() != self.spec.height {
            return EncodeOutcome::Failed;
        }

        unsafe {
            let sample = match self.build_sample(frame, timestamp_us) {
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

    fn name(&self) -> &'static str {
        "media-foundation"
    }
}

impl Drop for MediaFoundationEncoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let _ = self
                .transform
                .ProcessMessage(MFT_MESSAGE_NOTIFY_END_STREAMING, 0);
            // After the stream messages, so the transform is idle before its backing object goes.
            // This is what returns the encode session to the driver; releasing the interface alone
            // does not, and the next publish would find the encoder still in use.
            let _ = self.activate.ShutdownObject();
        }
    }
}

/// Every hardware H.264 encoder MF knows about, best first, each with the activate it came from.
///
/// The activate is handed back rather than dropped here because it is the only handle that can
/// shut the created object down, and every one of these has to be shut down whether or not it ends
/// up being the encoder we keep.
unsafe fn enumerate_hardware_encoders() -> Vec<(IMFActivate, IMFTransform)> {
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

    let mut transforms = Vec::new();
    for i in 0..count as usize {
        if let Some(activate) = (*activates.add(i)).take() {
            if let Ok(transform) = activate.ActivateObject::<IMFTransform>() {
                transforms.push((activate, transform));
            }
        }
    }
    windows::Win32::System::Com::CoTaskMemFree(Some(activates as *const _));
    transforms
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(width: u32, height: u32) -> EncoderSpec {
        EncoderSpec {
            width,
            height,
            fps: 30,
            kbps: 4000,
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
        assert!(MediaFoundationEncoder::new(spec(1921, 1080)).is_none());
        assert!(MediaFoundationEncoder::new(spec(1920, 1081)).is_none());
        assert!(MediaFoundationEncoder::new(spec(0, 0)).is_none());
    }

    /// Hardware encoding is machine-dependent: CI containers and VMs have no encoder, and that is
    /// a legitimate configuration rather than a failure. Where one exists, it must actually work.
    #[test]
    fn produces_annex_b_when_hardware_is_present() {
        let Some(mut encoder) = MediaFoundationEncoder::new(spec(640, 360)) else {
            eprintln!("no hardware H.264 encoder on this machine; skipping");
            return;
        };

        // Pipelined encoders emit nothing for the first frames, so feed a short run.
        let mut chunks = Vec::new();
        for i in 0..30u64 {
            if let EncodeOutcome::Chunk(chunk) = encoder.encode(&frame(640, 360, i as u32), i * 33_333) {
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
        let Some(mut encoder) = MediaFoundationEncoder::new(spec(640, 360)) else {
            return;
        };
        // Geometry is fixed for the session; a mismatch is a broken contract, not a skip.
        assert!(matches!(
            encoder.encode(&frame(320, 240, 0), 0),
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
        let built = MediaFoundationEncoder::new(EncoderSpec {
            width: 640,
            height: 360,
            fps: 30,
            kbps: 4000,
        });
        eprintln!("[probe] encoder constructed: {}", built.is_some());
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
            let Some(mut encoder) = MediaFoundationEncoder::new(EncoderSpec {
                width: w,
                height: h,
                fps: 30,
                kbps: 8000,
            }) else {
                eprintln!("[probe] {w}x{h}: no encoder would configure");
                continue;
            };

            let frames: Vec<RgbaImage> = (0..4).map(|i| frame(w, h, i * 7)).collect();
            let mut out = 0usize;
            let started = Instant::now();
            for i in 0..60u64 {
                if let EncodeOutcome::Chunk(_) = encoder.encode(&frames[i as usize % 4], i * 33_333)
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
