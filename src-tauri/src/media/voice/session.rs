//! Owns a running voice session: the input device, the capture thread, and the peer connection.
//!
//! The capture thread is a plain OS thread rather than a tokio task. It wakes on a 10 ms timer and
//! does bounded DSP work, which would otherwise occupy a runtime worker for the whole call. Encoded
//! packets cross to the async side over a bounded channel, exactly as the screen publisher does.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use super::capture;
use super::chain::{CaptureChain, ChainConfig};
use super::jitter::Packet;
use super::mixer::Mixer;
use super::playout;
use super::receive::RemoteSource;
use super::rtc::VoicePublication;
use super::{FRAME, FRAME_MS};
use crate::media::publisher::rtc::IceServerConfig;
use crate::media::publisher::signalling::Signalling;

/// How many encoded packets may queue between the capture thread and the async writer.
///
/// Small on purpose: voice that falls behind should drop rather than accumulate, because a backlog
/// becomes permanent latency that never recovers on its own.
const PACKET_QUEUE: usize = 8;

/// How many inbound RTP packets may queue between the network task and the playout thread.
///
/// Larger than `PACKET_QUEUE` because it is shared by every remote participant at once, and a burst
/// arriving together is normal rather than a symptom.
const INBOUND_QUEUE: usize = 256;

/// How many reference frames may queue between playout and capture.
///
/// Tiny, and dropped rather than blocked on: the echo canceller wants the frame that is about to be
/// played, so a stale backlog is worse than a gap.
const REFERENCE_QUEUE: usize = 4;

/// Frames between level reports to the frontend. 10 frames is 100 ms - fast enough for a speaking
/// indicator, and a hundredth of the traffic that sending one per frame would cost.
const LEVEL_REPORT_FRAMES: u32 = 10;

/// Remote sources, shared between the network task that fills them and the playout thread that
/// drains them.
///
/// One mutex around the whole map rather than one per source: the playout thread takes it once per
/// 10 ms frame, and contention is with a task that appends a participant a handful of times per
/// call. Per-source locks would cost more bookkeeping than they save.
type Sources = Arc<Mutex<HashMap<String, RemoteSource>>>;

/// mid -> source id. Written inside `subscribe`, before Cloudflare's answer is applied.
type MidMap = Arc<Mutex<HashMap<String, String>>>;

/// Emitted to the frontend. One channel carries every kind, so the webview subscribes once.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VoiceEvent {
    pub kind: String,
    pub speaking: bool,
    pub level: f32,
    pub message: Option<String>,
    /// Populated only on `kind: "levels"`, so the speaking-state payload stays small.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub levels: Vec<RemoteLevel>,
}

/// One remote participant's meter, for the speaking indicator.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteLevel {
    pub id: String,
    pub level: f32,
    pub speaking: bool,
}

impl VoiceEvent {
    pub fn speaking(speaking: bool, level: f32) -> Self {
        Self {
            kind: "speaking".into(),
            speaking,
            level,
            message: None,
            levels: Vec::new(),
        }
    }

    pub fn levels(levels: Vec<RemoteLevel>) -> Self {
        Self {
            kind: "levels".into(),
            speaking: false,
            level: 0.0,
            message: None,
            levels,
        }
    }

    #[allow(dead_code)]
    pub fn error(message: impl Into<String>) -> Self {
        Self {
            kind: "error".into(),
            speaking: false,
            level: 0.0,
            message: Some(message.into()),
            levels: Vec::new(),
        }
    }
}

/// Collapse the mixer's interleaved stereo frame to the mono frame the echo canceller expects.
///
/// Averaged rather than decimated, because the reference has to match the *energy* the speakers will
/// emit. Taking one channel, or every other sample, understates it and AEC3 then under-cancels by
/// exactly that much - which presents as "echo cancellation is on but weak", the hardest version of
/// this bug to notice.
fn reference_from(stereo: &[f32]) -> Vec<f32> {
    stereo
        .chunks_exact(2)
        .map(|pair| (pair[0] + pair[1]) / 2.0)
        .collect()
}

/// State shared between the Tauri command thread and the capture thread.
///
/// Atomics rather than a mutex: the capture thread reads these every 10 ms on a deadline, and it
/// must never wait on a UI thread that happens to be holding a lock.
#[derive(Default)]
pub struct Control {
    muted: AtomicBool,
    ptt_down: AtomicBool,
    stopped: AtomicBool,
    /// Config changes are rare and larger than a word, so this one is a mutex - but it is only
    /// locked when `dirty` says something changed, so the per-frame path never touches it.
    pending_config: Mutex<Option<ChainConfig>>,
    dirty: AtomicBool,
    /// Per-source volume, 0.0-1.0. Read by the playout thread only when `gains_dirty` says so, so
    /// the per-frame path does not take this lock.
    gains: Mutex<HashMap<String, f32>>,
    gains_dirty: AtomicBool,
    deafened: AtomicBool,
}

impl Control {
    pub fn muted(&self) -> bool {
        self.muted.load(Ordering::Relaxed)
    }

    pub fn set_muted(&self, muted: bool) {
        self.muted.store(muted, Ordering::Relaxed);
    }

    pub fn ptt_down(&self) -> bool {
        self.ptt_down.load(Ordering::Relaxed)
    }

    pub fn set_ptt_down(&self, down: bool) {
        self.ptt_down.store(down, Ordering::Relaxed);
    }

    pub fn running(&self) -> bool {
        !self.stopped.load(Ordering::Relaxed)
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Relaxed);
    }

    pub fn set_config(&self, config: ChainConfig) {
        if let Ok(mut guard) = self.pending_config.lock() {
            *guard = Some(config);
            self.dirty.store(true, Ordering::Release);
        }
    }

    fn take_config(&self) -> Option<ChainConfig> {
        if !self.dirty.swap(false, Ordering::Acquire) {
            return None;
        }
        self.pending_config.lock().ok().and_then(|mut g| g.take())
    }

    pub fn set_gain(&self, id: String, gain: f32) {
        if let Ok(mut guard) = self.gains.lock() {
            guard.insert(id, gain);
            self.gains_dirty.store(true, Ordering::Release);
        }
    }

    pub fn forget_gain(&self, id: &str) {
        if let Ok(mut guard) = self.gains.lock() {
            guard.remove(id);
            self.gains_dirty.store(true, Ordering::Release);
        }
    }

    /// The full gain table, or `None` when nothing changed since the last call.
    fn take_gains(&self) -> Option<HashMap<String, f32>> {
        if !self.gains_dirty.swap(false, Ordering::Acquire) {
            return None;
        }
        self.gains.lock().ok().map(|g| g.clone())
    }

    pub fn deafened(&self) -> bool {
        self.deafened.load(Ordering::Relaxed)
    }

    pub fn set_deafened(&self, deafened: bool) {
        self.deafened.store(deafened, Ordering::Relaxed);
    }
}

pub struct VoiceHandle {
    control: Arc<Control>,
    publication: Arc<VoicePublication>,
    sources: Sources,
    mids: MidMap,
    pub cf_session_id: String,
    pub track_name: String,
}

impl VoiceHandle {
    pub fn set_muted(&self, muted: bool) {
        self.control.set_muted(muted);
    }

    pub fn set_ptt_down(&self, down: bool) {
        self.control.set_ptt_down(down);
    }

    pub fn set_config(&self, config: ChainConfig) {
        self.control.set_config(config);
    }

    pub fn set_gain(&self, id: String, gain: f32) {
        self.control.set_gain(id, gain);
    }

    pub fn set_deafened(&self, deafened: bool) {
        self.control.set_deafened(deafened);
    }

    /// Pull one participant's track onto this session and start mixing them in.
    ///
    /// The source is created *before* the subscribe, so the mid-to-source mapping written inside
    /// `subscribe` always finds somewhere to put the opening packets.
    pub async fn subscribe(
        &self,
        id: String,
        cf_session_id: String,
        track_name: String,
    ) -> Result<(), String> {
        {
            let mut sources = self.sources.lock().map_err(|_| "sources poisoned")?;
            if sources.contains_key(&id) {
                // Already subscribed. Re-pulling would add a second transceiver for the same
                // participant and mix them in twice.
                return Ok(());
            }
            sources.insert(id.clone(), RemoteSource::new()?);
        }

        let mids = Arc::clone(&self.mids);
        let register_id = id.clone();
        let result = self
            .publication
            .subscribe(&[(cf_session_id, track_name)], move |assigned| {
                if let (Ok(mut map), Some(mid)) = (mids.lock(), assigned.first()) {
                    map.insert(mid.clone(), register_id);
                }
            })
            .await;

        if let Err(e) = result {
            // Roll the source back, or a failed subscribe leaves a permanently silent participant
            // in the mix and blocks every retry with the contains_key guard above.
            if let Ok(mut sources) = self.sources.lock() {
                sources.remove(&id);
            }
            return Err(e);
        }
        Ok(())
    }

    pub fn unsubscribe(&self, id: &str) {
        if let Ok(mut sources) = self.sources.lock() {
            sources.remove(id);
        }
        if let Ok(mut map) = self.mids.lock() {
            map.retain(|_, source_id| source_id != id);
        }
        self.control.forget_gain(id);
    }

    pub fn stop(&self) {
        self.control.stop();
    }
}

pub async fn start(
    device_id: Option<String>,
    output_device_id: Option<String>,
    ice_servers: Vec<IceServerConfig>,
    signalling: Signalling,
    config: ChainConfig,
    on_event: tauri::ipc::Channel<VoiceEvent>,
) -> Result<VoiceHandle, String> {
    let (stream, mut reader, input_hz) = capture::open(device_id.as_deref())?;
    let mut chain = CaptureChain::new(input_hz, config)?;
    let (output_stream, mut sink, _output_hz) = playout::open(output_device_id.as_deref())?;

    let publication = Arc::new(VoicePublication::start(signalling, ice_servers).await?);
    let cf_session_id = publication.cf_session_id.clone();
    let track_name = publication.track_name.clone();

    let control = Arc::new(Control::default());
    let sources: Sources = Arc::new(Mutex::new(HashMap::new()));
    let mids: MidMap = Arc::new(Mutex::new(HashMap::new()));

    let (packet_tx, mut packet_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(PACKET_QUEUE);
    let (inbound_tx, mut inbound_rx) =
        tokio::sync::mpsc::channel::<(String, Packet)>(INBOUND_QUEUE);
    // Bounded and dropped rather than blocked on: the canceller wants the frame about to be played,
    // so a stale backlog is worse than a gap.
    let (reference_tx, reference_rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(REFERENCE_QUEUE);

    publication.on_audio(inbound_tx);

    // Writer task: the peer connection is async, the capture thread is a blocking OS thread, so
    // packets cross over here rather than blocking capture on the network.
    let writer_publication = Arc::clone(&publication);
    tokio::spawn(async move {
        while let Some(packet) = packet_rx.recv().await {
            if let Err(e) = writer_publication.write_packet(packet).await {
                eprintln!("[voice] write failed, ending publication: {e}");
                break;
            }
        }
        writer_publication.stop().await;
    });

    // Inbound task: RTP arrives keyed by mid. The mid-to-source map is written inside `subscribe`
    // before Cloudflare's answer is applied, so a packet cannot arrive for a mid the map has not
    // seen - and a packet for an unsubscribed mid is simply not ours.
    let inbound_sources = Arc::clone(&sources);
    let inbound_mids = Arc::clone(&mids);
    let started = Instant::now();
    tokio::spawn(async move {
        while let Some((mid, packet)) = inbound_rx.recv().await {
            let Some(id) = inbound_mids
                .lock()
                .ok()
                .and_then(|map| map.get(&mid).cloned())
            else {
                continue;
            };
            let arrival_ms = started.elapsed().as_millis() as u64;
            if let Ok(mut sources) = inbound_sources.lock() {
                if let Some(source) = sources.get_mut(&id) {
                    source.push(packet, arrival_ms);
                }
            }
        }
    });

    // Playout thread: mixes every remote source at 10 ms and feeds the result to the device, and to
    // the echo canceller on the way past.
    let playout_control = Arc::clone(&control);
    let playout_sources = Arc::clone(&sources);
    let playout_events = on_event.clone();
    std::thread::Builder::new()
        .name("voice-playout".into())
        .spawn(move || {
            // Keeps the device open for the life of the thread.
            let _stream = output_stream;
            let tick = Duration::from_millis(FRAME_MS as u64);
            let mut mixer = Mixer::new();
            let mut mixed = vec![0.0f32; FRAME * 2];
            let mut next = Instant::now();
            let mut frames_since_report = 0u32;

            while playout_control.running() {
                next += tick;
                let now = Instant::now();
                if next > now {
                    std::thread::sleep(next - now);
                } else {
                    next = now;
                }

                if let Some(gains) = playout_control.take_gains() {
                    for (id, gain) in gains {
                        mixer.set_gain(&id, gain);
                    }
                }
                mixer.set_deafened(playout_control.deafened());

                // Collected into owned frames rather than borrowed from the map: `mix` wants a
                // slice of slices, and producing them mutates each source, so the borrow cannot be
                // held across the call.
                let (frames, levels) = match playout_sources.lock() {
                    Ok(mut sources) => {
                        let mut frames: Vec<(String, Vec<f32>)> = Vec::with_capacity(sources.len());
                        let mut levels: Vec<RemoteLevel> = Vec::with_capacity(sources.len());
                        for (id, source) in sources.iter_mut() {
                            frames.push((id.clone(), source.next_frame().to_vec()));
                            levels.push(RemoteLevel {
                                id: id.clone(),
                                level: source.level(),
                                speaking: source.speaking(),
                            });
                        }
                        (frames, levels)
                    }
                    Err(_) => (Vec::new(), Vec::new()),
                };

                let borrowed: Vec<(&str, &[f32])> = frames
                    .iter()
                    .map(|(id, frame)| (id.as_str(), frame.as_slice()))
                    .collect();
                mixer.mix(&borrowed, &mut mixed);

                // The reference goes to the capture chain *before* the frame reaches the speakers,
                // because AEC3 has to know what is about to come out of them. The capture thread
                // owns the chain, so this crosses as a message rather than a lock on the audio path.
                let _ = reference_tx.try_send(reference_from(&mixed));

                sink.write_stereo(&mixed);

                frames_since_report += 1;
                if frames_since_report >= LEVEL_REPORT_FRAMES {
                    frames_since_report = 0;
                    if !levels.is_empty() {
                        let _ = playout_events.send(VoiceEvent::levels(levels));
                    }
                }
            }
        })
        .map_err(|e| e.to_string())?;

    let thread_control = Arc::clone(&control);
    std::thread::Builder::new()
        .name("voice-capture".into())
        .spawn(move || {
            // Keeps the device open for the life of the thread.
            let _stream = stream;
            let tick = Duration::from_millis(FRAME_MS as u64);
            let mut frame = vec![0.0f32; FRAME];
            let mut last_speaking = false;
            let mut next = Instant::now();

            while thread_control.running() {
                next += tick;
                let now = Instant::now();
                if next > now {
                    std::thread::sleep(next - now);
                } else {
                    // Overran the budget. Resync rather than trying to catch up, which would spin
                    // and make the backlog worse.
                    next = now;
                }

                if let Some(config) = thread_control.take_config() {
                    chain.set_config(config);
                }
                chain.set_muted(thread_control.muted());
                chain.set_ptt_down(thread_control.ptt_down());

                // Drain every reference frame that arrived. More than one means playout ran ahead;
                // feeding them all keeps the canceller's notion of "what was played" aligned with
                // real time instead of silently falling behind by a frame per tick.
                while let Ok(reference) = reference_rx.try_recv() {
                    chain.render_reference(&reference);
                }

                // Drain everything the device produced, which may be more or fewer than one frame.
                while reader.read_frame(&mut frame) {
                    let status = chain.push(&frame, &mut |packet: &[u8]| {
                        // try_send, not send: dropping under backpressure keeps latency bounded,
                        // and a closed channel means the writer task already ended.
                        let _ = packet_tx.try_send(packet.to_vec());
                    });

                    if status.speaking != last_speaking {
                        last_speaking = status.speaking;
                        let _ = on_event.send(VoiceEvent::speaking(status.speaking, status.level));
                    }
                }
            }
        })
        .map_err(|e| e.to_string())?;

    Ok(VoiceHandle {
        control,
        publication,
        sources,
        mids,
        cf_session_id,
        track_name,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_echo_reference_is_mono_and_frame_sized() {
        // The APM silently ignores a frame of the wrong length. That is exactly how echo
        // cancellation ends up doing nothing while every other test still passes, so pin the shape.
        let stereo: Vec<f32> = (0..FRAME * 2).map(|i| i as f32 * 0.001).collect();
        let mono = reference_from(&stereo);
        assert_eq!(mono.len(), FRAME);
    }

    #[test]
    fn the_echo_reference_averages_rather_than_decimating() {
        // Taking one channel would halve the reference energy and leave AEC3 under-cancelling by
        // exactly that much - audible as "the canceller is on but weak", the hardest failure to
        // attribute. A hard-panned source must still show up at half level in the reference.
        let mut stereo = vec![0.0f32; FRAME * 2];
        for i in 0..FRAME {
            stereo[i * 2] = 1.0; // left only
        }
        let mono = reference_from(&stereo);
        assert!(mono.iter().all(|s| (*s - 0.5).abs() < 1e-6), "got {}", mono[0]);
    }

    #[test]
    fn gains_are_only_reported_once_per_change() {
        // The playout thread asks every 10 ms; handing it the table each time would mean locking on
        // the frame path for nothing.
        let control = Control::default();
        assert!(control.take_gains().is_none());

        control.set_gain("a".into(), 0.5);
        let gains = control.take_gains().expect("a change was pending");
        assert_eq!(gains.get("a"), Some(&0.5));
        assert!(control.take_gains().is_none(), "the change was consumed");
    }

    #[test]
    fn forgetting_a_gain_is_itself_a_change() {
        let control = Control::default();
        control.set_gain("a".into(), 0.5);
        control.take_gains();
        control.forget_gain("a");
        let gains = control.take_gains().expect("removal must be reported too");
        assert!(!gains.contains_key("a"));
    }

    #[test]
    fn deafen_defaults_off_and_round_trips() {
        let control = Control::default();
        assert!(!control.deafened());
        control.set_deafened(true);
        assert!(control.deafened());
    }

    #[test]
    fn a_levels_event_carries_its_payload_and_other_kinds_do_not() {
        let levels = VoiceEvent::levels(vec![RemoteLevel {
            id: "u1".into(),
            level: 0.4,
            speaking: true,
        }]);
        let json = serde_json::to_value(&levels).unwrap();
        assert_eq!(json["kind"], "levels");
        assert_eq!(json["levels"][0]["id"], "u1");
        assert_eq!(json["levels"][0]["speaking"], true);

        // Speaking events are sent far more often; they must not carry an empty array each time.
        let speaking = serde_json::to_value(VoiceEvent::speaking(true, 0.2)).unwrap();
        assert!(speaking.get("levels").is_none());
    }

    #[test]
    fn control_changes_are_visible_to_the_capture_thread() {
        let control = Control::default();
        assert!(!control.muted());
        assert!(!control.ptt_down());

        control.set_muted(true);
        control.set_ptt_down(true);
        assert!(control.muted());
        assert!(control.ptt_down());
    }

    #[test]
    fn a_stopped_session_stays_stopped() {
        let control = Control::default();
        assert!(control.running());
        control.stop();
        assert!(!control.running());
        // Idempotent: a second stop from a different path must not resurrect it.
        control.stop();
        assert!(!control.running());
    }

    #[test]
    fn control_is_shareable_across_threads() {
        let control = Arc::new(Control::default());
        let other = Arc::clone(&control);
        std::thread::spawn(move || other.set_muted(true)).join().unwrap();
        assert!(control.muted());
    }

    #[test]
    fn a_config_is_delivered_exactly_once() {
        use crate::media::voice::gate::{GateConfig, InputMode};
        use crate::media::voice::process::ProcessConfig;

        let control = Control::default();
        assert!(
            control.take_config().is_none(),
            "nothing was set, so there is nothing to apply"
        );

        control.set_config(ChainConfig {
            processing: ProcessConfig::default(),
            gate: GateConfig {
                mode: InputMode::PushToTalk,
                sensitivity: 0.25,
                release_ms: 200,
            },
            bitrate_bps: 32_000,
        });

        let taken = control.take_config().expect("a pending config must be applied");
        assert_eq!(taken.bitrate_bps, 32_000);
        assert_eq!(taken.gate.mode, InputMode::PushToTalk);

        // Taken once and not again: reapplying every frame would reset the processor continuously.
        assert!(control.take_config().is_none());
    }

    #[test]
    fn a_speaking_event_carries_the_level() {
        let event = VoiceEvent::speaking(true, 0.42);
        assert_eq!(event.kind, "speaking");
        assert!(event.speaking);
        assert!((event.level - 0.42).abs() < f32::EPSILON);
        assert!(event.message.is_none());
    }

    #[test]
    fn an_error_event_carries_a_message() {
        let event = VoiceEvent::error("device lost");
        assert_eq!(event.kind, "error");
        assert!(!event.speaking);
        assert_eq!(event.message.as_deref(), Some("device lost"));
    }

    #[test]
    fn events_serialise_with_the_keys_the_frontend_reads() {
        let json = serde_json::to_value(VoiceEvent::speaking(true, 0.5)).unwrap();
        assert_eq!(json["kind"], "speaking");
        assert_eq!(json["speaking"], true);
        assert_eq!(json["level"], 0.5);
    }
}
