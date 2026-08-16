//! What happens to one captured frame: fit, preview, keyframe policy, encode, enqueue.
//!
//! Lifted out of the capture closure in [`super::session`] so it can be driven without a screen.
//! Every rule in here was written for a failure a viewer suffers and the sharer cannot see - the
//! sharer's own tile is fed from this side of the socket and looks fine whether or not a single
//! byte ever reaches the wire - so each one is worth being able to assert on directly. That is
//! still true of the local stream added below: it is the encoder's output, not the network's, so it
//! proves the picture was *produced*, never that it was delivered.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use image::RgbaImage;

use super::encoder::{EncodeOutcome, EncoderSpec, VideoEncoder};
use super::fit::fit_into;
use super::session::PreviewFrame;

/// Width of the local self-preview, in pixels. It is a thumbnail in a tile, not the stream, so it
/// is small enough that JPEG over IPC costs nothing meaningful next to the encode itself.
const PREVIEW_WIDTH: u32 = 480;

/// Interval between preview frames. Fast enough to read as live, slow enough to stay free.
pub const PREVIEW_INTERVAL: Duration = Duration::from_millis(200);

/// How often the encode loop reports what it has produced. 150 frames is roughly five seconds at
/// the usual capture rate - often enough to watch a share start, rare enough not to fill a log.
const STATS_EVERY_FRAMES: u64 = 150;

/// The longest a viewer may wait for a decodable picture.
///
/// In wall-clock time on purpose. Both encoders take their keyframe interval as a frame count,
/// which is the wrong unit for a screen share: a static desktop produces only a few frames a
/// second, so a 60-frame interval that was meant to be two seconds becomes twenty. This bounds it
/// regardless of what the screen is doing.
pub const KEYFRAME_INTERVAL: Duration = Duration::from_secs(2);

/// Where the sharer's own thumbnail goes.
///
/// A trait only because `tauri::ipc::Channel` cannot be constructed outside a running app, and the
/// pump would otherwise be untestable for that one reason alone.
pub trait PreviewSink: Send + 'static {
    fn send(&self, frame: PreviewFrame);
}

impl PreviewSink for tauri::ipc::Channel<PreviewFrame> {
    fn send(&self, frame: PreviewFrame) {
        let _ = tauri::ipc::Channel::send(self, frame);
    }
}

/// Discards previews, for the paths that are not about the sharer's own tile.
impl PreviewSink for () {
    fn send(&self, _frame: PreviewFrame) {}
}

/// Bytes of header in front of every access unit handed to the webview's own decoder.
///
/// One flags byte then the presentation timestamp in microseconds, little-endian. `local-stream.ts`
/// parses this exact layout, so the two move together or the webview decodes garbage.
pub const LOCAL_STREAM_HEADER_LEN: usize = 9;

/// Bit 0 of the header's flags byte: this access unit is an IDR.
pub const LOCAL_STREAM_FLAG_KEYFRAME: u8 = 1;

/// Where a copy of the *encoded* stream goes, for the sharer's own tile.
///
/// <p>The picture the sharer sees used to be [`emit_preview`]'s thumbnail and nothing else: 480px
/// of JPEG five times a second, which is what "my stream looks terrible" was actually looking at.
/// The wire already carries a full-rate, full-resolution H.264 stream, so the local tile decodes
/// that instead - the same bytes every viewer gets, at a fraction of the IPC cost of a JPEG per
/// frame.</p>
///
/// <p>A trait for the same reason [`PreviewSink`] is one: `tauri::ipc::Channel` cannot be built
/// outside a running app.</p>
pub trait LocalStreamSink: Send + 'static {
    fn send(&self, access_unit: Vec<u8>);
}

impl LocalStreamSink for tauri::ipc::Channel<tauri::ipc::InvokeResponseBody> {
    fn send(&self, access_unit: Vec<u8>) {
        // Raw, not JSON: a `Raw` body over the threshold is fetched as binary by the webview, where
        // a serialised one would be base64 (a third bigger) or - worse, for the small chunks - a
        // JSON array of numbers, which is four bytes of IPC per byte of video.
        let _ = tauri::ipc::Channel::send(self, tauri::ipc::InvokeResponseBody::Raw(access_unit));
    }
}

/// Counters for one layer, for logging and for tests to assert on. A plain read-out: see
/// [`PumpCounters`] for the atomics this is snapshotted from.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct PumpStats {
    pub encoded_frames: u64,
    pub keyframes: u64,
    /// Frames the writer was too far behind to accept. Routine backpressure, not an error.
    pub dropped_frames: u64,
}

/// One layer's counters, written by the capture thread and read by whoever holds the handle.
///
/// <p>Relaxed ordering throughout. These are diagnostics: a reader that sees a count one frame
/// stale is showing a number that was true a sixtieth of a second ago, and paying for stronger
/// ordering on the encode path to avoid that would be the wrong trade.</p>
#[derive(Default)]
pub struct LayerCounters {
    pub encoded_frames: AtomicU64,
    pub keyframes: AtomicU64,
    /// Frames the writer was too far behind to accept. Routine backpressure, not an error.
    pub dropped_frames: AtomicU64,
}

/// Every layer's counters, shared between the pump and the publish handle.
///
/// <p><b>Per layer, where the old counting only tracked index 0.</b> That was right while nothing
/// could see the numbers - a lower layer's dropped frame is not the picture stuttering, so folding
/// it into the top layer's count would have been a lie about what the layer that actually failed
/// was doing. Now that each rung has its own row in the stats panel, the honest answer is one
/// counter set each, and a middle rung failing silently becomes readable rather than invisible.</p>
pub struct PumpCounters {
    pub layers: Vec<LayerCounters>,
}

impl PumpCounters {
    pub fn new(layers: usize) -> Self {
        Self {
            layers: (0..layers).map(|_| LayerCounters::default()).collect(),
        }
    }

    /// A consistent-enough read of every layer. Not atomic across layers, which does not matter:
    /// no consumer compares two layers' counts within one frame.
    pub fn snapshot(&self) -> Vec<PumpStats> {
        self.layers
            .iter()
            .map(|l| PumpStats {
                encoded_frames: l.encoded_frames.load(Ordering::Relaxed),
                keyframes: l.keyframes.load(Ordering::Relaxed),
                dropped_frames: l.dropped_frames.load(Ordering::Relaxed),
            })
            .collect()
    }
}

/// One encoding the pump drives: an encoder, the size it was built for, and where its output goes.
///
/// <p>The size lives here rather than being derived per frame because a layer's geometry and its
/// encoder's geometry must move as one step - [`super::encoder_sw::SoftwareEncoder::encode`] rejects
/// any frame whose dimensions differ from the spec it was built for, and that rejection is
/// [`EncodeOutcome::Failed`], which ends the capture loop.</p>
pub struct PumpLayer {
    pub encoder: Box<dyn VideoEncoder>,
    pub frame_tx: tokio::sync::mpsc::Sender<(Vec<u8>, Duration)>,
    pub width: u32,
    pub height: u32,
}

/// Turns captured frames into queued access units.
pub struct FramePump<P: PreviewSink> {
    /// Output geometry. The source can change size at any moment and is fitted to this; this
    /// itself moves only when [`Self::pending_spec`] is filled in, and only at a frame boundary.
    width: u32,
    height: u32,
    /// A resolution change waiting to be applied, written from outside the capture thread.
    ///
    /// <p>A cell rather than a direct call because the encoder belongs to this thread and cannot be
    /// touched from the IPC one, exactly as the keyframe request cannot - see `keyframe_wanted`.
    /// Applied at the top of [`Self::on_frame`], which is the only place `width`/`height` and the
    /// encoder's own geometry can be moved as one step.</p>
    pending_spec: Arc<Mutex<Option<EncoderSpec>>>,
    /// Read every frame, so a framerate change lands within one frame.
    fps: Arc<AtomicU32>,
    /// The simulcast ladder, highest layer first and never empty.
    ///
    /// <p>Index 0 is rid `a` and is the canonical stream: it owns the stats, the sharer's own tile
    /// and the keyframe clock. One element is the pre-simulcast share, and every rule in this file
    /// still reads exactly as it did then.</p>
    layers: Vec<PumpLayer>,
    /// Set when a viewer asks for a keyframe over RTCP, cleared as it is served.
    keyframe_wanted: Arc<AtomicBool>,
    /// The floor on how long a viewer waits for a decodable picture. A field rather than a constant
    /// read inline so tests can assert the rule in milliseconds instead of seconds.
    keyframe_interval: Duration,
    preview: P,
    /// A copy of the encoded stream for the sharer's own tile, when the webview can decode one.
    /// Absent on a host whose webview has no `VideoDecoder`, which falls back to the thumbnail.
    local_stream: Option<Box<dyn LocalStreamSink>>,
    /// Whether that copy is wanted *right now*. Flipped from the webview - see
    /// `PublishHandle::set_local_stream_enabled` - so a preview nobody is looking at stops costing
    /// the wire's whole bitrate over IPC. Unlike the thumbnail's pause, which only stops the
    /// webview applying frames, this one stops them being sent at all: at full rate that is the
    /// entire point of pausing.
    local_stream_on: Arc<AtomicBool>,

    /// When the first frame of this publish was pumped, so timestamps are an offset from it.
    ///
    /// Set on the first frame rather than at construction: `start` builds the pump before the
    /// capture thread has opened the source, and counting the gap in between would open every
    /// share with a lie.
    started: Option<Instant>,
    /// The previous frame's arrival, for the inter-frame duration handed to the writer.
    last_frame_at: Option<Instant>,
    jpeg_buf: Vec<u8>,
    next_preview: Instant,
    last_keyframe: Instant,
    counters: Arc<PumpCounters>,
}

impl<P: PreviewSink> FramePump<P> {
    /// # Panics
    ///
    /// If `layers` is empty. A pump with nothing to encode into is not a degraded share, it is a
    /// capture thread with no output at all - and the callers that build the ladder
    /// ([`super::simulcast::layers_for`], `session::start`) both guarantee at least one.
    pub fn new(
        layers: Vec<PumpLayer>,
        fps: Arc<AtomicU32>,
        keyframe_wanted: Arc<AtomicBool>,
        preview: P,
    ) -> Self {
        assert!(!layers.is_empty(), "a pump needs at least one layer to encode into");
        // The frame is fitted to the top layer and every lower one is scaled down from that, so
        // these two track layer 0 and are not an independent setting.
        let (width, height) = (layers[0].width, layers[0].height);
        // Computed before `layers` is moved into the struct below, since its length is all this
        // needs from it.
        let counters = Arc::new(PumpCounters::new(layers.len()));
        Self {
            width,
            height,
            pending_spec: Arc::new(Mutex::new(None)),
            fps,
            layers,
            keyframe_wanted,
            keyframe_interval: KEYFRAME_INTERVAL,
            preview,
            local_stream: None,
            local_stream_on: Arc::new(AtomicBool::new(false)),
            started: None,
            last_frame_at: None,
            jpeg_buf: Vec::with_capacity(64 * 1024),
            next_preview: Instant::now(),
            // In the past, so the very first frame of a share is a keyframe rather than waiting out
            // an interval before the first viewer can decode anything.
            last_keyframe: Instant::now() - KEYFRAME_INTERVAL,
            counters,
        }
    }

    /// Also hand the encoded stream to the sharer's own tile.
    ///
    /// <p>A builder step rather than another constructor parameter, because it is genuinely
    /// optional: a webview with no `VideoDecoder` never asks for one and keeps the thumbnail.</p>
    pub fn with_local_stream(mut self, sink: Box<dyn LocalStreamSink>, on: Arc<AtomicBool>) -> Self {
        self.local_stream = Some(sink);
        self.local_stream_on = on;
        self
    }

    /// Shorten the keyframe floor. Tests only: production wants [`KEYFRAME_INTERVAL`].
    #[cfg(test)]
    pub fn with_keyframe_interval(mut self, interval: Duration) -> Self {
        self.keyframe_interval = interval;
        self.last_keyframe = Instant::now() - interval;
        self
    }

    /// The counters, for whoever outlives this pump.
    ///
    /// <p>Handed out exactly like [`Self::pending_spec`] and for the same reason: `session::start`
    /// takes it before the pump moves onto the capture thread, which is the last moment the pump
    /// and the handle are reachable from the same place.</p>
    pub fn counters(&self) -> Arc<PumpCounters> {
        Arc::clone(&self.counters)
    }

    /// The cell a resolution change is posted into, for whoever outlives this pump.
    ///
    /// <p>Handed out rather than passed in so [`Self::new`]'s signature - and its four call sites -
    /// stay as they were. `session::start` takes it before the pump moves onto the capture thread,
    /// which is the last moment either half is reachable from the same place.</p>
    pub fn pending_spec(&self) -> Arc<Mutex<Option<EncoderSpec>>> {
        Arc::clone(&self.pending_spec)
    }

    /// Move this pump and its encoder to a new geometry, in one step.
    ///
    /// <p><b>The single step is the whole point.</b> `SoftwareEncoder::encode` rejects any frame
    /// whose dimensions differ from the spec it was built for, and that rejection is
    /// [`EncodeOutcome::Failed`] - which ends the capture loop. So a window in which `width` and
    /// the encoder disagree is not a glitch, it is a dead share. Nothing between the two
    /// assignments below may encode a frame.</p>
    ///
    /// <p>A refused reconfigure leaves the old geometry running rather than propagating. The share
    /// carries on at the resolution it already had, which is a picture the viewer can still watch;
    /// tearing it down because a driver declined a retype would turn a cosmetic failure into the
    /// outage this whole change exists to remove.</p>
    fn apply_spec(&mut self, spec: EncoderSpec) {
        // Recomputed from the incoming top-layer spec rather than scaled from the sizes currently
        // held, so repeated changes cannot ratchet the ladder down a step at a time.
        let ladder = super::simulcast::layers_for(spec, self.layers.len());

        for (layer, rung) in self.layers.iter_mut().zip(ladder.iter()) {
            if let Err(e) = layer.encoder.reconfigure(rung.spec) {
                // This layer carries on at the size it already had. A ladder whose rungs disagree
                // costs the SFU a good choice between them, which is a quality fault; tearing the
                // share down over it would turn that into the outage this path exists to avoid.
                eprintln!(
                    "[publisher] layer {} refused {}x{} ({e}); staying at {}x{}",
                    rung.rid, rung.spec.width, rung.spec.height, layer.width, layer.height
                );
                continue;
            }
            layer.width = rung.spec.width;
            layer.height = rung.spec.height;
        }

        // Taken from the layer rather than from `spec`, so a top layer that refused the retype
        // leaves the pump fitting to the geometry its encoder still expects. Setting it from `spec`
        // regardless is what would feed that encoder a frame it rejects, and a rejection there is
        // fatal to the capture loop.
        self.width = self.layers[0].width;
        self.height = self.layers[0].height;
        // The encoders were just built to expect this rate, and the capture loop paces off the same
        // atomic. Leaving them to disagree would have rate control dividing its budget by a number
        // nothing is producing at.
        self.fps.store(spec.fps.clamp(1, 60), Ordering::Relaxed);
        // A replacement shares no prediction state with what it replaced - and on the software path
        // it is a different object entirely - so the next frame has to be an IDR carrying the
        // SPS/PPS that describe the new size. Without it every viewer decodes garbage until the
        // periodic keyframe comes round. Every layer, or a viewer on one that was not asked waits
        // out the whole interval.
        for layer in self.layers.iter_mut() {
            layer.encoder.request_keyframe();
        }
        eprintln!(
            "[publisher] now encoding at {}x{} ({} kbps) across {} layer(s)",
            self.width,
            self.height,
            spec.kbps,
            self.layers.len()
        );
    }

    /// Fit, preview, encode and enqueue one captured frame.
    ///
    /// Never blocks. A writer that has fallen behind costs a dropped frame, not a stalled capture
    /// thread - for a live screen, bounded latency matters far more than completeness.
    pub fn on_frame(&mut self, rgba: &RgbaImage) {
        // Before the frame is fitted, because fitting reads the very geometry this moves. Taken
        // out of the cell rather than read from it, so a spec is applied once and a lock is never
        // held across the encode below.
        if let Some(spec) = self.pending_spec.lock().ok().and_then(|mut cell| cell.take()) {
            self.apply_spec(spec);
        }

        // Read the clock before the work, not after: the timestamp belongs to when the frame was
        // captured, and fitting and encoding it takes long enough at high resolutions to matter.
        let now = Instant::now();
        let started = *self.started.get_or_insert(now);

        // Both derived from the clock rather than from the declared framerate.
        //
        // A share reaches its configured rate only when capture, fit, convert and encode all fit
        // inside one frame interval, and at 1440p in an unoptimised build a single frame costs
        // four times that. Counting frames at the declared rate regardless is wrong twice over.
        // The encoder's rate control divides its bitrate budget by the rate it believes it is
        // being fed, so a 4 fps share timestamped as 30 fps spends an eighth of the bits it should
        // on every frame - which is why a slow share does not merely stutter, it turns to mush.
        // And the writer turns this duration into RTP timestamps, so a nominal value leaves the
        // receiver's clock running at a different rate to the sender's for the whole share.
        let timestamp_us = now.duration_since(started).as_micros() as u64;
        let frame_duration = match self.last_frame_at {
            Some(previous) => now.duration_since(previous),
            // Nothing to measure against yet, so fall back to the declared rate for one frame.
            None => Duration::from_micros(1_000_000 / self.fps.load(Ordering::Relaxed).max(1) as u64),
        };
        self.last_frame_at = Some(now);

        // Fit before encoding: the source can change size mid-session, the encoder cannot.
        let frame = fit_into(rgba, self.width, self.height);

        if now >= self.next_preview {
            self.next_preview = now + PREVIEW_INTERVAL;
            emit_preview(&frame, &mut self.jpeg_buf, &self.preview);
        }

        // A viewer who cannot decode has asked for a keyframe over RTCP. Honoured here because the
        // encoder belongs to this thread and cannot be reached from the network task that received
        // the request. This is what lets someone who joins mid-share, or who loses a burst of
        // packets, recover immediately instead of waiting out the periodic IDR. `swap` because the
        // request is cleared as it is served: a second viewer asking while this frame encodes will
        // set it again and get the next one.
        //
        // The wall clock is the other half. Both encoders express their keyframe interval in
        // *frames*, and a screen share's frame rate is whatever the screen is doing: a still
        // desktop produces a handful of frames a second, so an interval of `fps * 2` frames - two
        // seconds at the rate the encoder was configured for - can be twenty seconds of real time.
        // What a viewer waits is the wall clock, and until the first keyframe arrives they have
        // nothing to decode and show a placeholder. Measured at roughly 45 seconds to first picture
        // on a mostly-static screen. So the interval configured on the encoder is the ceiling, and
        // this is the floor.
        if self.keyframe_wanted.swap(false, Ordering::Relaxed)
            || now.duration_since(self.last_keyframe) >= self.keyframe_interval
        {
            // Every layer at the same moment. A viewer the SFU moves between layers can only decode
            // the new one from its next IDR, so layers that key independently would show a freeze
            // on every switch - on a static screen, for the whole keyframe interval.
            for layer in self.layers.iter_mut() {
                layer.encoder.request_keyframe();
            }
        }

        for index in 0..self.layers.len() {
            let (width, height) = (self.layers[index].width, self.layers[index].height);
            // Scaled from the already-fitted frame rather than from the raw capture: it is less
            // work, and it guarantees every layer shows identical framing down to the letterbox
            // bars. The top layer is the fitted frame itself, with no second copy.
            let scaled;
            let source = if width == self.width && height == self.height {
                &frame
            } else {
                scaled = fit_into(&frame, width, height);
                &scaled
            };

            let chunk = match self.layers[index].encoder.encode(source, timestamp_us) {
                EncodeOutcome::Chunk(chunk) => chunk,
                // Rate control, or a pipelined encoder still filling up. Normal.
                EncodeOutcome::Skipped => continue,
                EncodeOutcome::Failed => {
                    // The resilient wrapper already tried to fall back, so reaching here means this
                    // layer has nothing left to encode with. Only the top layer failing is the
                    // share failing; a lower one going quiet costs the SFU a choice, not a picture.
                    eprintln!(
                        "[publisher] layer {} failed with no fallback left",
                        super::simulcast::LAYER_RIDS.get(index).copied().unwrap_or("?")
                    );
                    continue;
                }
            };

            // Whether this share is producing anything, and whether it contains the keyframes a
            // viewer needs in order to start decoding. Nothing reported either before per-layer
            // counters existed, which left the two failures a viewer can suffer - "no picture ever
            // arrives" and "a picture arrives that I cannot decode" - indistinguishable from the
            // sharing side. Per layer, not just the top one: a lower layer going quiet used to be
            // invisible, and it is exactly the failure a "stats for nerds" panel exists to surface.
            let layer_counters = &self.counters.layers[index];
            layer_counters.encoded_frames.fetch_add(1, Ordering::Relaxed);
            if chunk.is_keyframe {
                layer_counters.keyframes.fetch_add(1, Ordering::Relaxed);
            }

            // The top layer alone still owns the keyframe clock, the periodic log and the sharer's
            // own tile. Counting every layer's log would spam three lines a frame; owning the
            // keyframe clock or the local tile from more than one layer would make either
            // meaningless. Only the counting above is per layer now - see PumpCounters.
            if index == 0 {
                if chunk.is_keyframe {
                    self.last_keyframe = now;
                }
                let encoded = layer_counters.encoded_frames.load(Ordering::Relaxed);
                if encoded % STATS_EVERY_FRAMES == 0 {
                    eprintln!(
                        "[publisher] {} frames encoded, {} keyframes, {} dropped at the writer",
                        encoded,
                        layer_counters.keyframes.load(Ordering::Relaxed),
                        layer_counters.dropped_frames.load(Ordering::Relaxed)
                    );
                }

                // The sharer's own tile, before the data is handed to the writer. Deliberately
                // *after* the counting above and before the `try_send` below, so the local picture
                // is the same access unit the wire carries - including one the writer then drops,
                // which is the right call: a frame the network could not take is still a frame this
                // machine already encoded, and dropping it locally too would make the sharer's own
                // tile stutter for a reason that is not theirs.
                self.emit_local_stream(&chunk.data, chunk.is_keyframe, timestamp_us);
            }

            // try_send, not send: dropping the newest frame when the writer is behind keeps latency
            // bounded. Full is routine backpressure; closed means the writer task already ended and
            // the capture loop will exit on its next stop check.
            //
            // Counted against the layer that actually dropped it. This used to be gated on
            // `index == 0`, so a lower layer's backpressure vanished entirely - the layer that was
            // struggling was never the one the number was about.
            if self.layers[index]
                .frame_tx
                .try_send((chunk.data, frame_duration))
                .is_err()
            {
                layer_counters.dropped_frames.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    /// Frame one access unit for the webview's decoder and send it, if one is listening.
    ///
    /// <p>The header is written here rather than by the sink so every implementation frames it
    /// identically - a sink that forgot the timestamp would produce a stream that decodes but
    /// plays at the wrong rate, which is far harder to spot than one that does not decode.</p>
    fn emit_local_stream(&self, data: &[u8], is_keyframe: bool, timestamp_us: u64) {
        let Some(sink) = &self.local_stream else {
            return;
        };
        if !self.local_stream_on.load(Ordering::Relaxed) {
            return;
        }

        let mut framed = Vec::with_capacity(LOCAL_STREAM_HEADER_LEN + data.len());
        framed.push(if is_keyframe {
            LOCAL_STREAM_FLAG_KEYFRAME
        } else {
            0
        });
        framed.extend_from_slice(&timestamp_us.to_le_bytes());
        framed.extend_from_slice(data);
        sink.send(framed);
    }
}

/// Downscale the already-fitted frame and hand it to the webview for the local tile.
///
/// The publisher never puts a MediaStream in the webview - that is the point of it - so the local
/// tile has nothing to render without this. JPEG is genuinely the right tool here: it is a
/// thumbnail, decoded once per 200 ms.
fn emit_preview(frame: &RgbaImage, buf: &mut Vec<u8>, sink: &impl PreviewSink) {
    let scale = PREVIEW_WIDTH as f32 / frame.width() as f32;
    // Never upscale a source that is already smaller than the preview box.
    let (width, height) = if scale >= 1.0 {
        (frame.width(), frame.height())
    } else {
        (
            PREVIEW_WIDTH,
            (frame.height() as f32 * scale).round().max(1.0) as u32,
        )
    };

    let thumb = image::DynamicImage::ImageRgba8(frame.clone())
        .resize(width, height, image::imageops::FilterType::Triangle)
        .to_rgb8();
    let out_width = thumb.width();
    let out_height = thumb.height();

    crate::media::screen::encode_jpeg_into(&image::DynamicImage::ImageRgb8(thumb), 70, buf);
    sink.send(PreviewFrame {
        data: crate::media::screen::base64_encode(buf),
        width: out_width,
        height: out_height,
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::publisher::encoder::{EncodedChunk, EncoderContent};

    /// What a [`RecordingEncoder`] was asked to do, readable from outside the pump that owns it.
    #[derive(Default)]
    struct EncoderLog {
        /// Presentation timestamps, one per encoded frame.
        seen: Vec<u64>,
        /// The dimensions of each frame as it reached the encoder. This is what proves the pump
        /// fits to the geometry it just moved to, rather than to the one it moved from.
        sizes: Vec<(u32, u32)>,
        /// Every spec the encoder was retyped to, in order.
        reconfigured: Vec<EncoderSpec>,
        keyframes_requested: u32,
    }

    /// Hands back one chunk per frame and records everything it was asked to do.
    struct RecordingEncoder {
        log: Arc<Mutex<EncoderLog>>,
        /// Set to make [`VideoEncoder::reconfigure`] refuse, the way a driver declining a retype
        /// does. The pump must then keep running at the geometry it already had.
        refuse_reconfigure: bool,
    }

    impl VideoEncoder for RecordingEncoder {
        fn encode(&mut self, frame: &RgbaImage, timestamp_us: u64) -> EncodeOutcome {
            let mut log = self.log.lock().unwrap();
            log.seen.push(timestamp_us);
            log.sizes.push((frame.width(), frame.height()));
            EncodeOutcome::Chunk(EncodedChunk {
                data: vec![0, 0, 0, 1, 0x65],
                is_keyframe: false,
                timestamp_us,
            })
        }

        fn request_keyframe(&mut self) {
            self.log.lock().unwrap().keyframes_requested += 1;
        }

        fn reconfigure(&mut self, spec: EncoderSpec) -> Result<(), String> {
            if self.refuse_reconfigure {
                return Err("this encoder refuses retypes".into());
            }
            self.log.lock().unwrap().reconfigured.push(spec);
            Ok(())
        }

        fn name(&self) -> &'static str {
            "recording"
        }
    }

    struct Harness {
        pump: FramePump<()>,
        log: Arc<Mutex<EncoderLog>>,
        fps: Arc<AtomicU32>,
        frames: tokio::sync::mpsc::Receiver<(Vec<u8>, Duration)>,
    }

    impl Harness {
        fn seen(&self) -> Vec<u64> {
            self.log.lock().unwrap().seen.clone()
        }
    }

    /// A pump declaring `fps`, with a queue deep enough that nothing under test is dropped.
    fn harness(fps: u32) -> Harness {
        harness_with(fps, false)
    }

    fn harness_with(fps: u32, refuse_reconfigure: bool) -> Harness {
        let log = Arc::new(Mutex::new(EncoderLog::default()));
        let fps = Arc::new(AtomicU32::new(fps));
        let (frame_tx, frames) = tokio::sync::mpsc::channel(64);
        // One layer, which is the pre-simulcast share. Every test below this point was written
        // before layers existed and must keep passing unchanged: that is what proves a one-layer
        // pump still behaves exactly as it always did.
        let pump = FramePump::new(
            vec![PumpLayer {
                encoder: Box::new(RecordingEncoder {
                    log: Arc::clone(&log),
                    refuse_reconfigure,
                }),
                frame_tx,
                width: 64,
                height: 64,
            }],
            Arc::clone(&fps),
            Arc::new(AtomicBool::new(false)),
            (),
        );
        Harness {
            pump,
            log,
            fps,
            frames,
        }
    }

    /// A recording encoder plus the log it writes to.
    fn recording_encoder() -> (Arc<Mutex<EncoderLog>>, Box<dyn VideoEncoder>) {
        let log = Arc::new(Mutex::new(EncoderLog::default()));
        let encoder = Box::new(RecordingEncoder {
            log: Arc::clone(&log),
            refuse_reconfigure: false,
        });
        (log, encoder)
    }

    /// A two-layer pump at 1920x1080 over 960x540, with both receivers handed back so nothing is
    /// dropped for want of somewhere to go.
    #[allow(clippy::type_complexity)]
    fn ladder_pump() -> (
        FramePump<()>,
        Arc<Mutex<EncoderLog>>,
        Arc<Mutex<EncoderLog>>,
        Arc<AtomicBool>,
        tokio::sync::mpsc::Receiver<(Vec<u8>, Duration)>,
        tokio::sync::mpsc::Receiver<(Vec<u8>, Duration)>,
    ) {
        let (top_log, top) = recording_encoder();
        let (mid_log, mid) = recording_encoder();
        let (top_tx, top_rx) = tokio::sync::mpsc::channel(64);
        let (mid_tx, mid_rx) = tokio::sync::mpsc::channel(64);
        let keyframe_wanted = Arc::new(AtomicBool::new(false));
        let pump = FramePump::new(
            vec![
                PumpLayer {
                    encoder: top,
                    frame_tx: top_tx,
                    width: 1920,
                    height: 1080,
                },
                PumpLayer {
                    encoder: mid,
                    frame_tx: mid_tx,
                    width: 960,
                    height: 540,
                },
            ],
            Arc::new(AtomicU32::new(30)),
            Arc::clone(&keyframe_wanted),
            (),
        );
        (pump, top_log, mid_log, keyframe_wanted, top_rx, mid_rx)
    }

    /// Every layer sees every frame, and each at its own size.
    #[test]
    fn feeds_one_captured_frame_to_every_layer() {
        let (mut pump, top_log, mid_log, _kf, mut top_rx, mut mid_rx) = ladder_pump();

        pump.on_frame(&RgbaImage::new(1920, 1080));

        assert_eq!(top_log.lock().unwrap().sizes, vec![(1920, 1080)]);
        assert_eq!(mid_log.lock().unwrap().sizes, vec![(960, 540)]);
        assert!(top_rx.try_recv().is_ok());
        assert!(mid_rx.try_recv().is_ok());
    }

    /// Layers key together, or a viewer the SFU moves between them waits out the whole keyframe
    /// interval with nothing decodable on the layer they just arrived at.
    #[test]
    fn asks_every_layer_for_a_keyframe_at_the_same_moment() {
        let (mut pump, top_log, mid_log, keyframe_wanted, _t, _m) = ladder_pump();
        keyframe_wanted.store(true, Ordering::Relaxed);

        pump.on_frame(&RgbaImage::new(1920, 1080));

        let top = top_log.lock().unwrap().keyframes_requested;
        let mid = mid_log.lock().unwrap().keyframes_requested;
        assert_eq!(top, mid, "layers asked for keyframes at different times");
        assert!(top >= 1);
    }

    /// A lower layer whose writer is full must not cost the top layer its frame or its stats.
    #[test]
    fn a_backed_up_lower_layer_does_not_stall_the_top_one() {
        let (top_log, top) = recording_encoder();
        let (_mid_log, mid) = recording_encoder();
        let (top_tx, mut top_rx) = tokio::sync::mpsc::channel(64);
        // Capacity 1, filled before the pump runs, so every send to it fails.
        let (mid_tx, _mid_rx_held) = tokio::sync::mpsc::channel(1);
        mid_tx
            .try_send((vec![0u8], Duration::from_millis(1)))
            .unwrap();

        let mut pump = FramePump::new(
            vec![
                PumpLayer {
                    encoder: top,
                    frame_tx: top_tx,
                    width: 1920,
                    height: 1080,
                },
                PumpLayer {
                    encoder: mid,
                    frame_tx: mid_tx,
                    width: 960,
                    height: 540,
                },
            ],
            Arc::new(AtomicU32::new(30)),
            Arc::new(AtomicBool::new(false)),
            (),
        );

        pump.on_frame(&RgbaImage::new(1920, 1080));

        assert_eq!(top_log.lock().unwrap().sizes.len(), 1);
        assert!(
            top_rx.try_recv().is_ok(),
            "the top layer lost a frame to a full lower one"
        );
        let snapshot = pump.counters().snapshot();
        assert_eq!(
            snapshot[0].dropped_frames, 0,
            "a lower layer's drop was counted against the top layer's stats"
        );
        assert_eq!(
            snapshot[1].dropped_frames, 1,
            "the lower layer's own drop must still be counted, just against its own layer"
        );
    }

    /// A resolution change moves every layer in one step, each to its own rung of the ladder.
    #[test]
    fn retypes_every_layer_together() {
        let (mut pump, top_log, mid_log, _kf, _t, _m) = ladder_pump();

        *pump.pending_spec().lock().unwrap() = Some(EncoderSpec {
            width: 1280,
            height: 720,
            fps: 30,
            kbps: 4000,
            content: EncoderContent::Text,
        });
        pump.on_frame(&RgbaImage::new(1920, 1080));

        assert_eq!(top_log.lock().unwrap().sizes, vec![(1280, 720)]);
        assert_eq!(mid_log.lock().unwrap().sizes, vec![(640, 360)]);
    }

    /// The sharer's own tile is fed from the top layer only. One copy per layer would triple the
    /// IPC cost of a preview nobody asked to see three times.
    #[test]
    fn copies_only_the_top_layer_to_the_local_tile() {
        struct Counting(Arc<Mutex<usize>>);
        impl LocalStreamSink for Counting {
            fn send(&self, _access_unit: Vec<u8>) {
                *self.0.lock().unwrap() += 1;
            }
        }

        let sent = Arc::new(Mutex::new(0usize));
        let (pump, _top_log, _mid_log, _kf, _t, _m) = ladder_pump();
        let mut pump = pump.with_local_stream(
            Box::new(Counting(Arc::clone(&sent))),
            Arc::new(AtomicBool::new(true)),
        );

        pump.on_frame(&RgbaImage::new(1920, 1080));

        assert_eq!(*sent.lock().unwrap(), 1);
    }

    fn frame() -> RgbaImage {
        RgbaImage::from_pixel(64, 64, image::Rgba([10, 20, 30, 255]))
    }

    /// Drains whatever the pump has queued so far.
    fn durations(harness: &mut Harness) -> Vec<Duration> {
        let mut out = Vec::new();
        while let Ok((_, duration)) = harness.frames.try_recv() {
            out.push(duration);
        }
        out
    }

    /// The gap the pump is told to expect, against the gap it is actually fed.
    ///
    /// A screen share reaches its declared framerate only if capture, fit, convert and encode all
    /// fit inside one frame interval. When they do not - a debug build, a 4K source, a busy
    /// machine - the frames still arrive, just further apart. What must not happen is the
    /// timestamps carrying on as though nothing had changed.
    const DECLARED_FPS: u32 = 30;
    const REAL_GAP: Duration = Duration::from_millis(100);

    #[test]
    fn timestamps_follow_the_clock_rather_than_the_declared_framerate() {
        let mut h = harness(DECLARED_FPS);
        for _ in 0..5 {
            h.pump.on_frame(&frame());
            std::thread::sleep(REAL_GAP);
        }

        let seen = h.seen();
        let span = seen.last().unwrap() - seen.first().unwrap();

        // Four gaps of 100 ms is 400 ms of real time. Counting frames at the declared 30 fps
        // instead gives 4 x 33 ms = 133 ms, and an encoder handed that believes it is being fed
        // three times faster than it is - so its rate control spends a full 30 fps bit budget on
        // frames that actually leave at 10, and every one of them is starved to a third of the
        // bits it needed. That is what turns a slow share into a blocky one.
        assert!(
            span > 300_000,
            "5 frames spanning 400 ms of wall clock were timestamped across only {} us - the pump \
             is counting frames at the declared rate instead of reading the clock",
            span
        );
    }

    #[test]
    fn the_frame_duration_handed_to_the_writer_is_the_real_gap() {
        let mut h = harness(DECLARED_FPS);
        h.pump.on_frame(&frame());
        std::thread::sleep(REAL_GAP);
        h.pump.on_frame(&frame());

        // The writer turns this into the sample duration, which is what the RTP timestamps are
        // built from. A nominal value here makes the receiver's clock run at a different rate to
        // the sender's for the whole share.
        let gaps = durations(&mut h);
        assert_eq!(gaps.len(), 2);
        assert!(
            gaps[1] > Duration::from_millis(70),
            "the second frame arrived 100 ms after the first but was declared {:?} long",
            gaps[1]
        );
    }

    #[test]
    fn the_first_frame_starts_at_zero() {
        let mut h = harness(DECLARED_FPS);
        h.pump.on_frame(&frame());
        assert_eq!(h.seen()[0], 0);
    }

    #[test]
    fn a_share_that_keeps_up_is_timestamped_at_about_its_declared_rate() {
        // The other side of the same rule: when capture *does* hold its rate, nothing changes.
        let mut h = harness(DECLARED_FPS);
        for _ in 0..4 {
            h.pump.on_frame(&frame());
            std::thread::sleep(Duration::from_millis(33));
        }

        let seen = h.seen();
        let span = seen.last().unwrap() - seen.first().unwrap();
        assert!(
            (70_000..170_000).contains(&span),
            "three 33 ms gaps should span about 100 ms, got {span} us"
        );
    }

    // â”€â”€ The sharer's own tile â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    /// Collects the framed access units meant for the webview's decoder.
    #[derive(Clone, Default)]
    struct RecordingLocalStream(Arc<std::sync::Mutex<Vec<Vec<u8>>>>);

    impl RecordingLocalStream {
        fn taken(&self) -> Vec<Vec<u8>> {
            self.0.lock().unwrap().clone()
        }
    }

    impl LocalStreamSink for RecordingLocalStream {
        fn send(&self, access_unit: Vec<u8>) {
            self.0.lock().unwrap().push(access_unit);
        }
    }

    /// The encoded payload the harness's encoder produces, which is what the local tile must get.
    const ENCODED: &[u8] = &[0, 0, 0, 1, 0x65];

    /// A pump wired to both the writer and a local-stream sink, with the sink's on/off gate.
    fn local_stream_harness(on: bool) -> (Harness, RecordingLocalStream, Arc<AtomicBool>) {
        let mut h = harness(DECLARED_FPS);
        let sink = RecordingLocalStream::default();
        let gate = Arc::new(AtomicBool::new(on));
        h.pump = h
            .pump
            .with_local_stream(Box::new(sink.clone()), Arc::clone(&gate));
        (h, sink, gate)
    }

    #[test]
    fn the_local_tile_gets_the_same_bytes_the_wire_does() {
        // The whole point of this path. The sharer used to watch a 480px JPEG thumbnail of their
        // own screen and reasonably conclude the stream was broken; what they see now is the
        // access unit itself, so "my stream looks bad" is finally a statement about the stream.
        let (mut h, sink, _gate) = local_stream_harness(true);

        h.pump.on_frame(&frame());

        let sent = sink.taken();
        assert_eq!(sent.len(), 1, "one frame in should be one access unit out");
        assert_eq!(
            &sent[0][LOCAL_STREAM_HEADER_LEN..],
            ENCODED,
            "the local tile was handed something other than the encoded frame"
        );
    }

    #[test]
    fn the_local_stream_header_carries_the_keyframe_flag_and_the_timestamp() {
        // Both are required by `EncodedVideoChunk`, and both fail quietly if they are wrong: a
        // delta announced as a keyframe decodes to garbage, and a bad timestamp plays at the wrong
        // rate. The harness encoder never emits an IDR, so this pins the delta case and the
        // timestamp together.
        let (mut h, sink, _gate) = local_stream_harness(true);

        h.pump.on_frame(&frame());

        let sent = sink.taken();
        let header = &sent[0][..LOCAL_STREAM_HEADER_LEN];
        assert_eq!(
            header[0] & LOCAL_STREAM_FLAG_KEYFRAME,
            0,
            "a delta frame was flagged as a keyframe"
        );
        let timestamp = u64::from_le_bytes(header[1..9].try_into().unwrap());
        assert_eq!(timestamp, 0, "the first frame of a share starts at zero");
    }

    #[test]
    fn turning_the_local_stream_off_stops_the_bytes_at_the_source() {
        // Not merely ignored in the webview, which is what the thumbnail's pause does: this path
        // carries the wire's entire bitrate over IPC, so a preview nobody is looking at has to
        // stop being *sent*. That is the only reason the gate exists.
        let (mut h, sink, gate) = local_stream_harness(false);

        h.pump.on_frame(&frame());
        assert!(sink.taken().is_empty(), "frames were sent while gated off");

        gate.store(true, Ordering::Relaxed);
        h.pump.on_frame(&frame());
        assert_eq!(sink.taken().len(), 1, "turning it back on sent nothing");
    }

    #[test]
    fn a_pump_with_no_local_stream_still_feeds_the_writer() {
        // The fallback host - a webview with no `VideoDecoder` - must be exactly the old pipeline.
        let mut h = harness(DECLARED_FPS);
        h.pump.on_frame(&frame());
        assert_eq!(durations(&mut h).len(), 1);
    }

    // â”€â”€ Resolution changes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    fn spec_at(width: u32, height: u32) -> EncoderSpec {
        EncoderSpec {
            width,
            height,
            fps: DECLARED_FPS,
            kbps: 2500,
            content: EncoderContent::Text,
        }
    }

    /// The hazard this whole path is built around.
    ///
    /// `SoftwareEncoder::encode` rejects any frame whose dimensions differ from the spec it was
    /// built for, and that rejection is `Failed`, which ends the capture loop. So the geometry
    /// frames are fitted to and the geometry the encoder expects must never disagree, not even for
    /// one frame. Asserting on the size the encoder was actually handed is the only way to see it:
    /// a pump that reconfigured the encoder and went on fitting to the old box would look
    /// completely healthy from every other angle and kill the share on a real encoder.
    #[test]
    fn a_resolution_change_moves_the_fit_and_the_encoder_in_the_same_frame() {
        let mut h = harness(DECLARED_FPS);
        h.pump.on_frame(&frame());

        *h.pump.pending_spec().lock().unwrap() = Some(spec_at(32, 48));
        h.pump.on_frame(&frame());

        let log = h.log.lock().unwrap();
        assert_eq!(
            log.reconfigured,
            vec![spec_at(32, 48)],
            "the encoder was not retyped"
        );
        assert_eq!(
            log.sizes,
            vec![(64, 64), (32, 48)],
            "frames were fitted to a geometry the encoder was not built for"
        );
    }

    #[test]
    fn a_resolution_change_asks_for_a_keyframe() {
        // The new encoder configuration shares no prediction state with the old one, and carries
        // the SPS/PPS describing the new size. Without an IDR every viewer decodes garbage until
        // the wall-clock interval comes round.
        let mut h = harness(DECLARED_FPS);
        h.pump.on_frame(&frame());
        let before = h.log.lock().unwrap().keyframes_requested;

        *h.pump.pending_spec().lock().unwrap() = Some(spec_at(32, 48));
        h.pump.on_frame(&frame());

        assert!(
            h.log.lock().unwrap().keyframes_requested > before,
            "a retype must be followed by an IDR"
        );
    }

    #[test]
    fn a_resolution_change_is_applied_once() {
        // Taken out of the cell rather than read from it. Re-applying it every frame would retype
        // the encoder - and on the software path rebuild it outright - at the capture rate.
        let mut h = harness(DECLARED_FPS);

        *h.pump.pending_spec().lock().unwrap() = Some(spec_at(32, 48));
        h.pump.on_frame(&frame());
        h.pump.on_frame(&frame());
        h.pump.on_frame(&frame());

        assert_eq!(h.log.lock().unwrap().reconfigured.len(), 1);
    }

    #[test]
    fn a_refused_retype_keeps_the_share_running_at_the_old_size() {
        // A driver that declines is a cosmetic failure. Propagating it would turn "the resolution
        // did not change" into "the stream ended", which is the outage this path exists to remove.
        let mut h = harness_with(DECLARED_FPS, true);

        *h.pump.pending_spec().lock().unwrap() = Some(spec_at(32, 48));
        h.pump.on_frame(&frame());
        h.pump.on_frame(&frame());

        let log = h.log.lock().unwrap();
        assert_eq!(
            log.sizes,
            vec![(64, 64), (64, 64)],
            "a refused retype must leave the fit geometry where it was"
        );
        assert_eq!(log.seen.len(), 2, "the pump stopped encoding");
    }

    #[test]
    fn a_resolution_change_carries_its_framerate_to_the_capture_loop() {
        // The encoder is rebuilt expecting this rate and the capture loop paces off the same
        // atomic. Leaving them to disagree has rate control dividing its budget by a number
        // nothing is producing at, which is what makes a slow share look like mush rather than
        // merely stutter.
        let mut h = harness(DECLARED_FPS);

        *h.pump.pending_spec().lock().unwrap() = Some(EncoderSpec {
            fps: 15,
            ..spec_at(32, 48)
        });
        h.pump.on_frame(&frame());

        assert_eq!(h.fps.load(Ordering::Relaxed), 15);
    }

    // ── Per-layer counters ─────────────────────────────────────────────────────────────────

    /// A pump with `layers` layers, wired the same way [`harness`] wires one. For tests that only
    /// care about [`FramePump::counters`] and never inspect what each layer actually encoded.
    fn test_pump(layers: usize) -> FramePump<()> {
        let layers = (0..layers)
            .map(|_| {
                let (_log, encoder) = recording_encoder();
                let (frame_tx, _rx) = tokio::sync::mpsc::channel(64);
                PumpLayer {
                    encoder,
                    frame_tx,
                    width: 64,
                    height: 64,
                }
            })
            .collect();
        FramePump::new(
            layers,
            Arc::new(AtomicU32::new(30)),
            Arc::new(AtomicBool::new(false)),
            (),
        )
    }

    /// A lower layer's drops used to be invisible: only index 0 counted anything. The counters are
    /// per layer now, so a ladder whose middle rung is silently failing is readable from the UI.
    #[test]
    fn counters_are_kept_per_layer_not_only_for_the_top() {
        let counters = PumpCounters::new(3);

        counters.layers[0].encoded_frames.fetch_add(10, Ordering::Relaxed);
        counters.layers[1].dropped_frames.fetch_add(4, Ordering::Relaxed);
        counters.layers[2].keyframes.fetch_add(1, Ordering::Relaxed);

        let snapshot = counters.snapshot();
        assert_eq!(snapshot.len(), 3);
        assert_eq!(snapshot[0].encoded_frames, 10);
        assert_eq!(snapshot[1].dropped_frames, 4);
        assert_eq!(snapshot[2].keyframes, 1);
        // The top layer's own drop count must not absorb a lower layer's.
        assert_eq!(snapshot[0].dropped_frames, 0);
    }

    /// The handle reads these after the pump has moved onto the capture thread, so the Arc handed
    /// out by `counters()` and the one the pump writes through must be the same allocation.
    #[test]
    fn the_handed_out_counters_are_the_ones_the_pump_writes() {
        let pump = test_pump(1);
        let counters = pump.counters();

        pump.counters().layers[0].encoded_frames.fetch_add(7, Ordering::Relaxed);

        assert_eq!(counters.snapshot()[0].encoded_frames, 7);
    }
}
