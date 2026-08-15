//! Owns a running publish: capture thread, encoder, and the peer connection feeding Cloudflare.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use image::RgbaImage;

use super::encoder::{new_encoder, EncoderContent, EncoderSpec};
use super::pump::FramePump;
use super::rtc::{FrameSink, Publication};
use super::signalling::{Signalling, VideoIntent};
use crate::media::screen::{find_capture_source, run_capture_loop};

/// How many encoded frames may queue between the capture thread and the async writer.
///
/// Small on purpose: a screen share that falls behind should drop frames and stay current rather
/// than build a backlog and drift further behind real time.
const FRAME_QUEUE: usize = 2;

/// Consecutive failed writes tolerated before the publication is considered dead.
///
/// More than a handful, because the failure this exists for arrives in bursts: a socket whose send
/// queue is full stays full for as long as it takes to drain, so one oversized frame can fail
/// several writes in a row and then recover completely. Few enough that a connection which has
/// genuinely gone away is torn down within a second rather than encoding into a void.
pub const WRITE_FAILURES_BEFORE_GIVING_UP: u32 = 30;

/// A downscaled frame for the sharer's own tile.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PreviewFrame {
    /// base64-encoded JPEG.
    pub data: String,
    pub width: u32,
    pub height: u32,
}

/// How long [`PublishHandle::stop`] waits for the capture thread to actually be gone.
///
/// Long enough for one frame of work at any resolution this client offers, and short enough that a
/// wedged driver call costs a pause rather than a share that can never be restarted.
const CAPTURE_EXIT_TIMEOUT: Duration = Duration::from_secs(2);

pub struct PublishHandle {
    stop_tx: Mutex<Option<std::sync::mpsc::SyncSender<()>>>,
    /// Disconnects when the capture thread returns, so `stop` can wait for it.
    capture_gone: Mutex<std::sync::mpsc::Receiver<()>>,
    /// Read every frame by the capture loop, so a framerate change lands within one frame.
    fps: Arc<AtomicU32>,
    /// Output geometry, and the target the encoder is currently built for. Moves under
    /// [`PublishHandle::set_geometry`], which is the only thing that may change either.
    width: AtomicU32,
    height: AtomicU32,
    /// Where [`PublishHandle::set_geometry`] posts a resolution change for the pump to pick up.
    pending_spec: Arc<Mutex<Option<super::encoder::EncoderSpec>>>,
    pub media_session_id: String,
    pub track_name: String,
    /// Present only when this share carries its own sound. Viewers read it out of the snapshot's
    /// `shares[].trackNames`, so it has to reflect what was actually published rather than what was
    /// asked for - a machine with no usable loopback device publishes video only.
    pub audio_track_name: Option<String>,
    pub encoder_name: &'static str,
    /// Stopped alongside the capture loop, so the loopback device is released with the share.
    screen_audio: Option<super::audio::ScreenAudioCapture>,
    /// Whether a copy of the encoded stream is currently going to the sharer's own tile.
    /// Always false on a host that never asked for one - see [`PublishHandle::set_local_stream_enabled`].
    local_stream_on: Arc<AtomicBool>,
    /// The same flag a viewer's RTCP PLI sets, held here so re-enabling the local stream can ask
    /// for an IDR the way a new viewer does.
    keyframe_wanted: Arc<AtomicBool>,
}

impl PublishHandle {
    pub fn set_fps(&self, fps: u32) {
        self.fps.store(fps.clamp(1, 60), Ordering::Relaxed);
    }

    pub fn geometry(&self) -> (u32, u32) {
        (
            self.width.load(Ordering::Relaxed),
            self.height.load(Ordering::Relaxed),
        )
    }

    /// Move the running publish to a new resolution and bitrate, without ending it.
    ///
    /// <p>This is what a resolution change is now. Everything the wire and the room can see - the
    /// Cloudflare session, the peer connection, the RTP stream, the track name, and therefore the
    /// share id - is untouched; only the encoder behind them is retyped, at a frame boundary, by
    /// the capture thread that owns it. Viewers receive a new SPS/PPS and an IDR at the new size,
    /// which is indistinguishable from any encoder adapting on its own, and nothing is announced
    /// to anybody.</p>
    ///
    /// <p>Previously this was a stop and a start: a new session, a new share id, and a hole of one
    /// to four seconds during which every viewer's tile left the grid entirely.</p>
    ///
    /// <p>The geometry recorded here is what was <em>asked for</em>. [`super::pump::FramePump`] is
    /// free to refuse it - a driver that declines a retype leaves the share running at the old size
    /// - so this is the request, not a reading of the encoder.</p>
    ///
    /// <p><b>Takes the whole spec, and is the only writer of `pending_spec`.</b> The content mode
    /// arrives here too rather than through a call of its own: one writer is what makes the ordering
    /// rule on [`super::encoder::VideoEncoder::reconfigure`] - geometry and encoder move in the same
    /// step, never around each other - something the type can enforce rather than something every
    /// future caller has to remember.</p>
    pub fn set_spec(&self, width: u32, height: u32, kbps: u32, content: EncoderContent) {
        let spec = super::encoder::EncoderSpec {
            width,
            height,
            fps: self.fps.load(Ordering::Relaxed).clamp(1, 60),
            kbps,
            content,
        };
        if let Ok(mut cell) = self.pending_spec.lock() {
            // Overwritten rather than queued. Two changes arriving between frames means the user
            // clicked twice; only the second one is a resolution anybody asked to watch.
            *cell = Some(spec);
        }
        self.width.store(width, Ordering::Relaxed);
        self.height.store(height, Ordering::Relaxed);
    }

    /// Stop capturing, and do not return until the capture thread has actually gone.
    ///
    /// <p>The wait is the point. Asking the thread to stop and returning immediately leaves it
    /// running for the rest of the frame it is in the middle of - up to 300 ms at 4K in an
    /// unoptimised build - and the caller that cannot tolerate that is the one that stops a publish
    /// in order to start another, because every part of the pipeline is then live twice over: two
    /// capture sessions duplicating the same monitor, two Media Foundation encoders configuring
    /// against the same hardware, and the outgoing one's `Drop` sending `END_STREAMING` while the
    /// incoming one negotiates its media types.</p>
    ///
    /// <p>A resolution change used to be exactly that caller and no longer is - it goes through
    /// [`PublishHandle::set_geometry`] instead, which never stops anything. What still reaches here
    /// is stopping a share to share a different source, which starts a new publish just the same.</p>
    ///
    /// <p>Bounded rather than an outright join, so a driver call that never returns costs a pause
    /// instead of a screen share that can never be started again.</p>
    pub fn stop(&self) {
        // Explicit, and not left to the writer task noticing its channel closed: the loopback device
        // is a system-wide capture, and leaving it open after a share ends is both a battery cost
        // and, on the process-excluded path, a WASAPI client nothing will reclaim until exit.
        if let Some(audio) = &self.screen_audio {
            audio.stop();
        }
        // Dropping the sender disconnects the channel; the capture loop's recv_timeout returns
        // Disconnected and unwinds the whole pipeline.
        if let Ok(mut guard) = self.stop_tx.lock() {
            guard.take();
        }
        // The thread holds the other end and drops it on the way out, so this returns
        // `Disconnected` the moment it is gone - and `Timeout` only if it never was.
        if let Ok(gone) = self.capture_gone.lock() {
            if gone.recv_timeout(CAPTURE_EXIT_TIMEOUT) == Err(std::sync::mpsc::RecvTimeoutError::Timeout) {
                // Worth saying out loud. Anything started after this shares the capture source and
                // the encoder with a thread that is still using both, which is the state a
                // resolution change used to enter on purpose.
                eprintln!(
                    "[publisher] the capture thread did not exit within {CAPTURE_EXIT_TIMEOUT:?}; \
                     whatever starts next will overlap with it"
                );
            }
        }
    }

    /// Counters for the audio half. `None` when this share has no audio.
    pub fn screen_audio_stats(&self) -> Option<super::audio::ScreenAudioStats> {
        self.screen_audio.as_ref().map(|a| a.stats())
    }

    /// Start or stop the copy of the encoded stream that feeds the sharer's own tile.
    ///
    /// <p>The webview turns this off when nobody is looking at the local picture - the window went
    /// behind something, or the preview has been idle. That matters far more here than it did for
    /// the thumbnail it replaces: this carries the share's whole bitrate across the IPC boundary,
    /// so an unwatched preview is the most expensive thing in the pipeline rather than a rounding
    /// error, and it is stopped at the source instead of merely ignored on arrival.</p>
    ///
    /// <p>Turning it back on asks for a keyframe. A decoder that has missed everything since the
    /// stream was cut has no reference frames for the deltas that follow, so without this the
    /// picture stays frozen until the wall-clock keyframe interval comes round - up to
    /// [`super::pump::KEYFRAME_INTERVAL`] of a resume that visibly did nothing.</p>
    ///
    /// <p>A no-op on a host that never asked for a local stream: the pump has no sink, so the flag
    /// has nothing to gate and requesting a keyframe would spend an IDR on nobody.</p>
    pub fn set_local_stream_enabled(&self, enabled: bool) {
        let was_on = self.local_stream_on.swap(enabled, Ordering::Relaxed);
        if enabled && !was_on {
            self.keyframe_wanted.store(true, Ordering::Relaxed);
        }
    }

    /// Mute the share's own sound. Silently ignored on a video-only share.
    pub fn set_screen_audio_muted(&self, muted: bool) {
        if let Some(audio) = &self.screen_audio {
            audio.set_muted(muted);
        }
    }
}

/// Drain encoded frames into the transport until the pump stops or the connection dies.
///
/// The peer connection is async and the capture loop is a blocking OS thread, so encoded frames
/// cross over here rather than blocking capture on the network.
///
/// Generic over the sink so the failure handling below can be exercised: it is the whole reason
/// this is a function rather than an inline `tokio::spawn`.
pub async fn run_writer<S: FrameSink>(
    sink: S,
    mut frame_rx: tokio::sync::mpsc::Receiver<(Vec<u8>, Duration)>,
) {
    let mut consecutive_failures = 0u32;
    while let Some((data, duration)) = frame_rx.recv().await {
        match sink.write_frame(data, duration).await {
            Ok(()) => consecutive_failures = 0,
            Err(e) => {
                consecutive_failures += 1;
                // A failed write used to end the share outright, and the most common failure here
                // is not fatal at all: Windows answers WSAENOBUFS (os error 10055) when a UDP
                // socket's send queue is momentarily full, which is exactly what a keyframe does -
                // one intra frame is hundreds of packets handed to the socket at once. So the first
                // large frame of a share could kill the publication, and the viewer would sit on a
                // placeholder forever while this side went on capturing and encoding perfectly
                // happily. Nothing above reported it, because the share was still "running"
                // everywhere except on the wire.
                //
                // Dropping the frame is the right answer: video is not worth retrying, the next
                // frame is already on its way, and a keyframe that fails will be reissued by the
                // wall-clock interval or by a viewer's PLI. Only a run of failures means the
                // connection itself is gone.
                if consecutive_failures >= WRITE_FAILURES_BEFORE_GIVING_UP {
                    eprintln!(
                        "[publisher] {consecutive_failures} consecutive write failures, \
                         ending publication: {e}"
                    );
                    break;
                }
                eprintln!("[publisher] dropped a frame: {e}");
            }
        }
    }
    sink.stop().await;
}

/// Feed encoded Opus packets to the share's audio track until the encoder stops producing.
///
/// <p>No failure counting, unlike [`run_writer`]. A failed audio write means one lost 20 ms packet;
/// Opus and the receiver's jitter buffer handle that, and there is no equivalent of the keyframe
/// dependency that makes a lost *video* frame matter beyond itself. The publication's lifetime is
/// decided by the video writer, so this task ends when its channel closes and never on its own.</p>
pub async fn run_audio_writer(
    track: Arc<webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample>,
    mut packets: tokio::sync::mpsc::Receiver<super::audio::OpusPacket>,
) {
    while let Some(packet) = packets.recv().await {
        let sample = webrtc::media::Sample {
            data: packet.into(),
            timestamp: std::time::SystemTime::now(),
            duration: OPUS_PACKET_DURATION,
            ..Default::default()
        };
        if let Err(e) = track.write_sample(&sample).await {
            eprintln!("[publisher] dropped a screen-audio packet: {e}");
        }
    }
}

/// 20 ms, matching `voice::codec::PACKET_SAMPLES` at 48 kHz. The packetiser derives RTP timestamps
/// from this, so a value that disagrees with the encoder makes every viewer's jitter buffer wrong.
const OPUS_PACKET_DURATION: Duration = Duration::from_millis(20);

/// Start capturing, encoding and publishing a source.
///
/// Returns once the track is live on Cloudflare, so the caller can tell other clients to subscribe.
#[allow(clippy::too_many_arguments)]
pub async fn start(
    source_id: String,
    share_id: String,
    width: u32,
    height: u32,
    fps: u32,
    kbps: u32,
    content: EncoderContent,
    ice_servers: Vec<crate::media::publisher::rtc::IceServerConfig>,
    signalling: Signalling,
    on_preview: tauri::ipc::Channel<PreviewFrame>,
    // A copy of the encoded stream for the sharer's own tile, or `None` on a webview that cannot
    // decode one and falls back to `on_preview`'s thumbnail.
    on_local_stream: Option<tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>>,
    share_audio: bool,
) -> Result<PublishHandle, String> {
    let spec = EncoderSpec {
        width,
        height,
        fps,
        kbps,
        content,
    };
    let encoder = new_encoder(spec)
        .ok_or_else(|| "no H.264 encoder available (OpenH264 not provisioned?)".to_string())?;
    let encoder_name = encoder.name();

    // The audio capture is started *before* the publication, so a machine with no usable loopback
    // device publishes a video-only share rather than a share advertising a silent audio track.
    // Viewers read `shares[].trackNames`, so a track that exists and never carries anything is worse
    // than one that was never announced.
    let screen_audio = if share_audio {
        match super::audio::start() {
            Ok(started) => Some(started),
            Err(e) => {
                eprintln!("[publisher] screen audio unavailable, sharing video only: {e}");
                None
            }
        }
    } else {
        None
    };

    // The solved output geometry, which is what the encoder above was just built for - not the
    // preset's nominal height. An ultrawide fitted into a 1080p box encodes 540 lines, and declaring
    // 1080 would have the server cap a share that is well inside its rung.
    let publication = Publication::start(
        signalling,
        &share_id,
        ice_servers,
        screen_audio.is_some(),
        VideoIntent::new(height, fps),
    )
    .await?;
    let media_session_id = publication.media_session_id.clone();
    let track_name = publication.track_name.clone();
    // Taken before the publication is moved into the writer task below.
    let keyframe_requests = publication.keyframe_requests();
    let audio_track = publication.audio_track();
    let audio_track_name = publication.audio_track_name.clone();

    // One AtomicU32, three holders: the capture loop's pacing, the pump's frame-interval maths, and
    // the handle `set_publish_fps` writes through. It used to be two plus a *fourth* freshly
    // allocated for the handle, so every framerate change from the UI was stored somewhere nothing
    // read - `set_publish_fps` has never changed the capture rate of a running share.
    let fps_arc = Arc::new(AtomicU32::new(fps.clamp(1, 60)));
    let capture_fps = Arc::clone(&fps_arc);
    let handle_fps = Arc::clone(&fps_arc);
    let (stop_tx, stop_rx) = std::sync::mpsc::sync_channel::<()>(1);
    let (frame_tx, frame_rx) = tokio::sync::mpsc::channel::<(Vec<u8>, Duration)>(FRAME_QUEUE);

    tokio::spawn(run_writer(publication, frame_rx));

    // The audio writer is its own task and deliberately not part of `run_writer`. The two have
    // different failure meanings: a run of failed *video* writes means the connection is gone and
    // ends the publication, whereas audio that stops arriving is a share whose sound was muted or
    // whose device vanished, and ending the whole share over it would take the picture with it.
    let audio_capture = match (screen_audio, audio_track) {
        (Some((capture, packets)), Some(track)) => {
            tokio::spawn(run_audio_writer(track, packets));
            Some(capture)
        }
        // Capture started but the track did not exist, or vice versa. Neither should be reachable -
        // the publication is told whether audio exists by `screen_audio.is_some()` - but leaving a
        // capture running with nowhere to write would hold the device open for the whole share.
        (Some((capture, _)), None) => {
            capture.stop();
            None
        }
        _ => None,
    };

    // On from the first frame when the webview asked for one: the tile that requested it is on
    // screen already, and starting gated-off would show nothing until the first pause/resume.
    let local_stream_on = Arc::new(AtomicBool::new(on_local_stream.is_some()));

    let mut pump = FramePump::new(
        width,
        height,
        fps_arc,
        encoder,
        Arc::clone(&keyframe_requests),
        on_preview,
        frame_tx,
    );
    if let Some(channel) = on_local_stream {
        pump = pump.with_local_stream(Box::new(channel), Arc::clone(&local_stream_on));
    }
    // Taken before the pump moves onto the capture thread below - the last point at which the pump
    // and the handle are reachable from the same place.
    let pending_spec = pump.pending_spec();

    let (capture_gone_tx, capture_gone) = std::sync::mpsc::sync_channel::<()>(0);

    std::thread::Builder::new()
        .name("sc-publish".into())
        .spawn(move || {
            // Held for the life of the thread and never sent on. Dropping it as the thread unwinds
            // is what tells `stop` the capture is really finished - including the early return
            // below, and including a panic.
            let _capture_gone = capture_gone_tx;

            let Some(source) = find_capture_source(&source_id) else {
                eprintln!("[publisher] capture source {source_id} not found");
                return;
            };

            run_capture_loop(source, capture_fps, stop_rx, move |rgba: RgbaImage, _w, _h| {
                pump.on_frame(&rgba)
            });
        })
        .map_err(|e| e.to_string())?;

    Ok(PublishHandle {
        stop_tx: Mutex::new(Some(stop_tx)),
        capture_gone: Mutex::new(capture_gone),
        fps: handle_fps,
        width: AtomicU32::new(width),
        height: AtomicU32::new(height),
        pending_spec,
        media_session_id,
        track_name,
        audio_track_name,
        encoder_name,
        screen_audio: audio_capture,
        local_stream_on,
        keyframe_wanted: keyframe_requests,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::time::Instant;

    /// A handle wired to a thread that behaves like the capture loop: it notices the stop, finishes
    /// the frame it is in the middle of, and only then returns.
    fn handle_with_a_busy_capture_thread(frame_cost: Duration) -> (PublishHandle, Arc<AtomicBool>) {
        let (stop_tx, stop_rx) = std::sync::mpsc::sync_channel::<()>(1);
        let (capture_gone_tx, capture_gone) = std::sync::mpsc::sync_channel::<()>(0);
        let finished = Arc::new(AtomicBool::new(false));
        let thread_finished = Arc::clone(&finished);

        std::thread::spawn(move || {
            let _capture_gone = capture_gone_tx;
            // Blocks until the sender is dropped, exactly as `run_capture_loop` does.
            let _ = stop_rx.recv();
            // The frame already in flight when the stop arrived.
            std::thread::sleep(frame_cost);
            thread_finished.store(true, Ordering::Relaxed);
        });

        let handle = PublishHandle {
            stop_tx: Mutex::new(Some(stop_tx)),
            capture_gone: Mutex::new(capture_gone),
            fps: Arc::new(AtomicU32::new(30)),
            width: AtomicU32::new(1920),
            height: AtomicU32::new(1080),
            pending_spec: Arc::new(Mutex::new(None)),
            media_session_id: "sess".into(),
            track_name: "screen-1".into(),
            audio_track_name: None,
            encoder_name: "test",
            screen_audio: None,
            local_stream_on: Arc::new(AtomicBool::new(false)),
            keyframe_wanted: Arc::new(AtomicBool::new(false)),
        };
        (handle, finished)
    }

    #[test]
    fn stopping_waits_for_the_capture_thread_to_finish() {
        // The whole point of the wait. A resolution change stops one publish in order to start
        // another, and the encoder and capture source it is about to open are the same ones this
        // thread is still holding.
        let (handle, finished) = handle_with_a_busy_capture_thread(Duration::from_millis(150));

        handle.stop();

        assert!(
            finished.load(Ordering::Relaxed),
            "stop returned while the capture thread was still running a frame"
        );
    }

    #[test]
    fn stopping_gives_up_rather_than_hanging_on_a_wedged_capture_thread() {
        // A driver call that never returns must cost a pause, not a screen share that can never be
        // started again.
        let (handle, _finished) = handle_with_a_busy_capture_thread(CAPTURE_EXIT_TIMEOUT * 4);

        let started = Instant::now();
        handle.stop();
        let waited = started.elapsed();

        assert!(waited >= CAPTURE_EXIT_TIMEOUT, "gave up too early after {waited:?}");
        assert!(
            waited < CAPTURE_EXIT_TIMEOUT * 2,
            "waited {waited:?}, which is past the bound"
        );
    }

    #[test]
    fn resuming_the_local_stream_asks_for_a_keyframe() {
        // Without this the sharer presses resume and watches a frozen frame for up to
        // KEYFRAME_INTERVAL, because every delta that arrives references frames their decoder was
        // switched off for.
        let (handle, _finished) = handle_with_a_busy_capture_thread(Duration::ZERO);

        handle.set_local_stream_enabled(true);

        assert!(handle.keyframe_wanted.load(Ordering::Relaxed));
    }

    #[test]
    fn a_local_stream_that_was_already_on_does_not_burn_a_keyframe() {
        // The webview re-asserts the state it wants rather than tracking transitions, so this is
        // called with `true` far more often than the stream actually resumes. An IDR per call
        // would be a bitrate spike every time nothing changed.
        let (handle, _finished) = handle_with_a_busy_capture_thread(Duration::ZERO);
        handle.set_local_stream_enabled(true);
        handle.keyframe_wanted.store(false, Ordering::Relaxed);

        handle.set_local_stream_enabled(true);

        assert!(!handle.keyframe_wanted.load(Ordering::Relaxed));
    }

    #[test]
    fn stopping_a_publish_whose_capture_never_started_returns_at_once() {
        // `find_capture_source` can fail, and the thread then returns before capturing anything.
        let (handle, _finished) = handle_with_a_busy_capture_thread(Duration::ZERO);

        let started = Instant::now();
        handle.stop();

        assert!(started.elapsed() < CAPTURE_EXIT_TIMEOUT, "waited out the whole timeout");
    }
}
