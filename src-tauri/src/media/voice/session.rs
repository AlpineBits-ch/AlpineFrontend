//! The client's one audio engine, and the publications hanging off it.
//!
//! There is exactly one microphone capture and one speaker playout for the whole client, however
//! many calls are running. A guild channel and Isle proximity voice are two *publications* - two
//! peer connections to two SFU sessions - sharing that single pair of devices, one capture chain
//! and one mixer.
//!
//! That sharing is not just tidiness. The echo canceller's reference is the frame about to reach
//! the speakers, so it can only cancel audio it can see: with a second engine running its own
//! playout, proximity voice would leak into the guild microphone and nothing could remove it.
//! One mixer means one reference containing everything, and AEC3 cancels all of it.
//!
//! The capture thread is a plain OS thread rather than a tokio task. It wakes on a 10 ms timer and
//! does bounded DSP work, which would otherwise occupy a runtime worker for the whole call. Encoded
//! packets cross to the async side over bounded channels, exactly as the screen publisher does.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;

use super::capture;
use super::chain::{CaptureChain, ChainConfig};
use super::gate::InputMode;
use super::jitter::Packet;
use super::mixer::{Mixer, Position, SpatialModel};
use super::playout;
use super::receive::RemoteSource;
use super::rtc::{PublicationStats, VoicePublication};
use super::{FRAME, FRAME_MS};

/// How many encoded packets may queue between the capture thread and one publication's writer.
///
/// Small on purpose: voice that falls behind should drop rather than accumulate, because a backlog
/// becomes permanent latency that never recovers on its own.
const PACKET_QUEUE: usize = 8;

/// How many inbound RTP packets may queue between a publication's network task and playout.
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

/// Remote sources, shared between the network tasks that fill them and the playout thread that
/// drains them.
///
/// Shared across every publication rather than one map each, because there is one mixer: a guild
/// participant and a proximity peer are both just sources with unique ids. One mutex around the
/// whole map rather than one per source: the playout thread takes it once per 10 ms frame, and
/// contention is with a task that appends a participant a handful of times per call.
type Sources = Arc<Mutex<HashMap<String, RemoteSource>>>;

/// mid -> source id, for one publication.
///
/// Per publication, not shared. Mids are numbered within a peer connection, so two publications
/// both have a mid `"0"`; a single map would route one call's audio into the other's participant.
type MidMap = Arc<Mutex<HashMap<String, String>>>;

/// Engine-wide counters, for `voice_stats`.
///
/// The capture and playout halves of the pipeline both used to be completely unobservable: a dead
/// microphone, a gate that never opened and a mixer producing silence all presented identically as
/// "the call works but nobody can hear anything". These separate them.
#[derive(Default)]
pub struct EngineStats {
    /// 10 ms frames the capture chain has taken from the device. Zero means the input device is
    /// producing nothing, whatever the settings page shows.
    pub frames_captured: AtomicU64,
    /// RMS of the most recent captured frame, as raw `f32` bits - the level *before* the gate, so a
    /// live microphone behind a shut gate is distinguishable from a dead one.
    pub capture_rms_bits: AtomicU32,
    /// Opus packets the chain has produced. Frames captured but no packets means the gate never
    /// opened - mute, push-to-talk, or the sensitivity threshold.
    pub packets_encoded: AtomicU64,
    /// Frames the playout thread has mixed and written to the output device.
    pub playout_frames: AtomicU64,
    /// RMS of the most recent mixed frame. Non-zero here with silence in the room means the output
    /// device is the problem, not the pipeline feeding it.
    pub mix_rms_bits: AtomicU32,
}

impl EngineStats {
    fn store_rms(slot: &AtomicU32, frame: &[f32]) {
        if frame.is_empty() {
            return;
        }
        let sum: f32 = frame.iter().map(|s| s * s).sum();
        slot.store((sum / frame.len() as f32).sqrt().to_bits(), Ordering::Relaxed);
    }

    pub fn capture_rms(&self) -> f32 {
        f32::from_bits(self.capture_rms_bits.load(Ordering::Relaxed))
    }

    pub fn mix_rms(&self) -> f32 {
        f32::from_bits(self.mix_rms_bits.load(Ordering::Relaxed))
    }
}

/// Where captured audio goes, and whether it is going there right now.
struct Sink {
    slot: String,
    open: Arc<AtomicBool>,
    packets: tokio::sync::mpsc::Sender<Bytes>,
    /// The publication's own counters, so a packet dropped at this hop is attributed to the call it
    /// was meant for rather than to the engine as a whole.
    stats: Arc<PublicationStats>,
}

type Sinks = Arc<Mutex<Vec<Sink>>>;

/// The event channels the frontend is listening on, one per publication.
type Events = Arc<Mutex<Vec<(String, tauri::ipc::Channel<VoiceEvent>)>>>;

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

/// Whether a publication should be routed audio the moment it starts.
///
/// Push-to-talk starts closed and is opened by a key press; voice activity has no such gesture, so
/// it starts open and the gate decides frame by frame. Getting this backwards would either leave a
/// push-to-talk user transmitting from the moment they join, or leave a voice-activity user
/// inaudible until they pressed a key they have not bound.
fn starts_open(mode: InputMode) -> bool {
    mode != InputMode::PushToTalk
}

/// State shared between the Tauri command thread and the audio threads.
///
/// Everything here is engine-wide: one microphone, one set of speakers, one mixer. Per-target state
/// lives on [`Publication`] instead.
///
/// Atomics rather than a mutex: the audio threads read these every 10 ms on a deadline, and must
/// never wait on a UI thread that happens to be holding a lock.
pub struct Control {
    muted: AtomicBool,
    /// Whether *any* publication currently wants audio. Derived from the publications rather than
    /// set directly - see [`Engine::refresh_gate`].
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
    /// Master output volume as raw `f32` bits, 0.0-1.0.
    ///
    /// Bits rather than a float because there is no `AtomicF32`, and an atomic rather than joining
    /// `pending_config` because that one belongs to the capture thread and this is read by playout.
    master_bits: AtomicU32,

    /// How placed sources fall off and how hard they are panned.
    ///
    /// A mutex behind a dirty flag rather than a pile of atomics, because these numbers are tuned
    /// together and have to reach the mixer as one - a model applied field by field would be
    /// briefly incoherent every time proximity voice reconfigured itself. Set once per Isle
    /// connect, so the flag is false on essentially every frame.
    spatial_model: Mutex<Option<SpatialModel>>,
    spatial_model_dirty: AtomicBool,
    /// Listener-relative positions, keyed by source id. `None` centres a source.
    ///
    /// Same shape as `gains`: a mutex the frame path only locks when `positions_dirty` says
    /// something moved. Positions arrive far more often than gains - every player movement tick -
    /// so leaving this to be polled per frame would put a lock on the audio path.
    positions: Mutex<HashMap<String, Option<Position>>>,
    positions_dirty: AtomicBool,
    /// Sources that have left, for the mixer to forget entirely.
    ///
    /// Distinct from a `None` position: the mixer holds a convolution tail per placed source, and
    /// merely un-placing someone would leave that state alive for a participant who is gone.
    departed: Mutex<Vec<String>>,
}

/// Written out rather than derived: every other field's zero value is the right default, and this
/// one's is silence. A derived `Default` would ship a session whose output volume starts at zero.
impl Default for Control {
    fn default() -> Self {
        Self {
            muted: AtomicBool::new(false),
            ptt_down: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            pending_config: Mutex::new(None),
            dirty: AtomicBool::new(false),
            gains: Mutex::new(HashMap::new()),
            gains_dirty: AtomicBool::new(false),
            deafened: AtomicBool::new(false),
            master_bits: AtomicU32::new(1.0f32.to_bits()),
            // Absent, not defaulted: the mixer already starts on `SpatialModel::default()`, and
            // pushing an identical copy on the first frame would only look like a configuration
            // step that had happened when it had not.
            spatial_model: Mutex::new(None),
            spatial_model_dirty: AtomicBool::new(false),
            positions: Mutex::new(HashMap::new()),
            positions_dirty: AtomicBool::new(false),
            departed: Mutex::new(Vec::new()),
        }
    }
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

    fn forget_gain(&self, id: &str) {
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

    /// How placed sources fall off and how hard they are panned.
    ///
    /// A model that would silence or corrupt the mix is dropped rather than stored - see
    /// [`SpatialModel::validated`]. Reported so the caller learns its tuning was ignored instead of
    /// wondering why proximity voice sounds unchanged.
    pub fn set_spatial_model(&self, model: SpatialModel) -> Result<(), String> {
        let Some(model) = model.validated() else {
            return Err(format!("nonsensical spatial model: {model:?}"));
        };
        if let Ok(mut guard) = self.spatial_model.lock() {
            *guard = Some(model);
            self.spatial_model_dirty.store(true, Ordering::Release);
        }
        Ok(())
    }

    /// The pending model, or `None` when nothing was reconfigured since the last call.
    fn take_spatial_model(&self) -> Option<SpatialModel> {
        if !self.spatial_model_dirty.swap(false, Ordering::Acquire) {
            return None;
        }
        self.spatial_model.lock().ok().and_then(|mut g| g.take())
    }

    pub fn set_position(&self, id: String, position: Option<Position>) {
        if let Ok(mut guard) = self.positions.lock() {
            guard.insert(id, position);
            self.positions_dirty.store(true, Ordering::Release);
        }
    }

    /// Every position that changed since the last call, or `None` when nothing moved.
    fn take_positions(&self) -> Option<HashMap<String, Option<Position>>> {
        if !self.positions_dirty.swap(false, Ordering::Acquire) {
            return None;
        }
        self.positions.lock().ok().map(|p| p.clone())
    }

    /// Drop every trace of a source that has left the call.
    fn forget_source(&self, id: &str) {
        self.forget_gain(id);
        if let Ok(mut guard) = self.positions.lock() {
            guard.remove(id);
            self.positions_dirty.store(true, Ordering::Release);
        }
        if let Ok(mut guard) = self.departed.lock() {
            guard.push(id.to_owned());
        }
    }

    /// Sources the mixer should forget. Drained, so each is reported exactly once.
    fn take_departed(&self) -> Vec<String> {
        match self.departed.lock() {
            Ok(mut guard) if !guard.is_empty() => std::mem::take(&mut *guard),
            _ => Vec::new(),
        }
    }

    pub fn master(&self) -> f32 {
        f32::from_bits(self.master_bits.load(Ordering::Relaxed))
    }

    /// Master output volume, 0.0-1.0. Anything not finite is ignored rather than stored: a NaN here
    /// would multiply the whole mix to NaN and silence every participant at once.
    pub fn set_master(&self, gain: f32) {
        if !gain.is_finite() {
            return;
        }
        self.master_bits
            .store(gain.clamp(0.0, 1.0).to_bits(), Ordering::Relaxed);
    }
}

/// One peer connection to one SFU session, and the participants pulled onto it.
///
/// Publications share the engine's devices, capture chain and mixer; what they own is transport and
/// routing. `open` is per publication so proximity push-to-talk cannot open the guild channel's
/// microphone, which is the reason Isle had a separate capture of its own before this.
pub struct Publication {
    inner: Arc<VoicePublication>,
    mids: MidMap,
    /// Source ids pulled onto this publication, so stopping it removes exactly its own from the
    /// shared source map and leaves any other call's participants alone.
    subscribed: Mutex<HashSet<String>>,
    open: Arc<AtomicBool>,
    sources: Sources,
    control: Arc<Control>,
    pub media_session_id: String,
    pub track_name: String,
}

impl Publication {
    pub fn open(&self) -> bool {
        self.open.load(Ordering::Relaxed)
    }

    /// This publication's transport counters.
    pub fn stats(&self) -> Arc<PublicationStats> {
        self.inner.stats()
    }

    /// Source ids currently pulled onto this publication.
    pub fn subscribed_ids(&self) -> Vec<String> {
        match self.subscribed.lock() {
            Ok(subscribed) => {
                let mut ids: Vec<String> = subscribed.iter().cloned().collect();
                ids.sort();
                ids
            }
            Err(_) => Vec::new(),
        }
    }

    /// The mid-to-source routing table, as `mid -> id`.
    ///
    /// Reported because it is the join between two halves that are each individually healthy: RTP
    /// arrives keyed by mid, sources are keyed by id, and if this table disagrees with either the
    /// audio is dropped with nothing to show for it.
    pub fn mid_routes(&self) -> Vec<(String, String)> {
        match self.mids.lock() {
            Ok(map) => {
                let mut routes: Vec<(String, String)> =
                    map.iter().map(|(m, id)| (m.clone(), id.clone())).collect();
                routes.sort();
                routes
            }
            Err(_) => Vec::new(),
        }
    }

    pub fn set_open(&self, open: bool) {
        self.open.store(open, Ordering::Relaxed);
    }

    /// Pull one participant's track onto this publication and start mixing them in.
    ///
    /// The source is created *before* the subscribe, so the mid-to-source mapping written inside
    /// `subscribe` always finds somewhere to put the opening packets.
    pub async fn subscribe(
        &self,
        id: String,
        media_session_id: String,
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
        if let Ok(mut subscribed) = self.subscribed.lock() {
            subscribed.insert(id.clone());
        }

        let mids = Arc::clone(&self.mids);
        let register_id = id.clone();
        let result = self
            .inner
            .subscribe(&[(media_session_id, track_name)], move |assigned| {
                if let (Ok(mut map), Some(mid)) = (mids.lock(), assigned.first()) {
                    map.insert(mid.clone(), register_id);
                }
            })
            .await;

        if let Err(e) = result {
            // Roll the source back, or a failed subscribe leaves a permanently silent participant
            // in the mix and blocks every retry with the contains_key guard above.
            self.unsubscribe(&id);
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
        if let Ok(mut subscribed) = self.subscribed.lock() {
            subscribed.remove(id);
        }
        // Or a departed participant keeps their gain and position in the tables, and the mixer keeps
        // a convolution tail for somebody who is gone.
        self.control.forget_source(id);
    }

    /// Take every participant on this publication out of the shared mix.
    fn unsubscribe_all(&self) {
        let ids: Vec<String> = match self.subscribed.lock() {
            Ok(subscribed) => subscribed.iter().cloned().collect(),
            Err(_) => Vec::new(),
        };
        for id in ids {
            self.unsubscribe(&id);
        }
    }
}

/// The devices, the DSP and the publications sharing them.
pub struct Engine {
    control: Arc<Control>,
    sources: Sources,
    sinks: Sinks,
    events: Events,
    stats: Arc<EngineStats>,
    publications: HashMap<String, Arc<Publication>>,
    /// The input mode the capture chain is running in, so a publication starting mid-call knows
    /// whether to open immediately or wait for a key press.
    input_mode: InputMode,
}

impl Engine {
    /// Open the devices and start the audio threads.
    ///
    /// The devices are chosen once here, not per publication: joining a second call while one is
    /// running reuses the microphone and speakers already open. A device change therefore takes
    /// effect when the last call ends and the engine next starts, which is the same "next join"
    /// rule the settings page described before, just measured against the engine.
    pub fn start(
        device_id: Option<String>,
        output_device_id: Option<String>,
        config: ChainConfig,
    ) -> Result<Self, String> {
        let (stream, mut reader, input_hz) = capture::open(device_id.as_deref())?;
        let mut chain = CaptureChain::new(input_hz, config)?;
        let (output_stream, mut sink, _output_hz) = playout::open(output_device_id.as_deref())?;

        let control = Arc::new(Control::default());
        let sources: Sources = Arc::new(Mutex::new(HashMap::new()));
        let sinks: Sinks = Arc::new(Mutex::new(Vec::new()));
        let events: Events = Arc::new(Mutex::new(Vec::new()));
        let stats = Arc::new(EngineStats::default());
        eprintln!("[voice] engine started: input {input_hz} Hz, output {_output_hz} Hz");

        // Bounded and dropped rather than blocked on: the canceller wants the frame about to be
        // played, so a stale backlog is worse than a gap.
        let (reference_tx, reference_rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(REFERENCE_QUEUE);

        // Playout thread: mixes every remote source at 10 ms and feeds the result to the device, and
        // to the echo canceller on the way past. One thread for the whole client, so the reference
        // contains every call's audio and AEC3 can cancel all of it.
        let playout_control = Arc::clone(&control);
        let playout_sources = Arc::clone(&sources);
        let playout_events = Arc::clone(&events);
        let playout_stats = Arc::clone(&stats);
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
                    mixer.set_master(playout_control.master());
                    if let Some(model) = playout_control.take_spatial_model() {
                        mixer.set_spatial_model(model);
                    }
                    if let Some(positions) = playout_control.take_positions() {
                        for (id, position) in positions {
                            mixer.set_position(&id, position);
                        }
                    }
                    // After the tables above, so a participant who left in the same tick they were
                    // last updated is still forgotten rather than reinstated.
                    for id in playout_control.take_departed() {
                        mixer.remove(&id);
                    }

                    // Collected into owned frames rather than borrowed from the map: `mix` wants a
                    // slice of slices, and producing them mutates each source, so the borrow cannot
                    // be held across the call.
                    let (frames, levels) = match playout_sources.lock() {
                        Ok(mut sources) => {
                            let mut frames: Vec<(String, Vec<f32>)> =
                                Vec::with_capacity(sources.len());
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
                    playout_stats.playout_frames.fetch_add(1, Ordering::Relaxed);
                    EngineStats::store_rms(&playout_stats.mix_rms_bits, &mixed);

                    // The reference goes to the capture chain *before* the frame reaches the
                    // speakers, because AEC3 has to know what is about to come out of them. The
                    // capture thread owns the chain, so this crosses as a message rather than a lock
                    // on the audio path.
                    let _ = reference_tx.try_send(reference_from(&mixed));

                    sink.write_stereo(&mixed);

                    frames_since_report += 1;
                    if frames_since_report >= LEVEL_REPORT_FRAMES {
                        frames_since_report = 0;
                        if !levels.is_empty() {
                            broadcast(&playout_events, VoiceEvent::levels(levels));
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;

        // Capture thread: one microphone, one chain, one encode - fanned out to every publication
        // that currently wants audio.
        let capture_control = Arc::clone(&control);
        let capture_sinks = Arc::clone(&sinks);
        let capture_events = Arc::clone(&events);
        let capture_stats = Arc::clone(&stats);
        std::thread::Builder::new()
            .name("voice-capture".into())
            .spawn(move || {
                // Keeps the device open for the life of the thread.
                let _stream = stream;
                let tick = Duration::from_millis(FRAME_MS as u64);
                let mut frame = vec![0.0f32; FRAME];
                let mut last_speaking = false;
                let mut next = Instant::now();

                while capture_control.running() {
                    next += tick;
                    let now = Instant::now();
                    if next > now {
                        std::thread::sleep(next - now);
                    } else {
                        // Overran the budget. Resync rather than trying to catch up, which would
                        // spin and make the backlog worse.
                        next = now;
                    }

                    if let Some(config) = capture_control.take_config() {
                        chain.set_config(config);
                    }
                    chain.set_muted(capture_control.muted());
                    chain.set_ptt_down(capture_control.ptt_down());

                    // Drain every reference frame that arrived. More than one means playout ran
                    // ahead; feeding them all keeps the canceller's notion of "what was played"
                    // aligned with real time instead of silently falling behind by a frame per tick.
                    while let Ok(reference) = reference_rx.try_recv() {
                        chain.render_reference(&reference);
                    }

                    // Drain everything the device produced, which may be more or fewer than one
                    // frame.
                    while reader.read_frame(&mut frame) {
                        capture_stats.frames_captured.fetch_add(1, Ordering::Relaxed);
                        EngineStats::store_rms(&capture_stats.capture_rms_bits, &frame);
                        let status = chain.push(&frame, &mut |packet: &[u8]| {
                            capture_stats.packets_encoded.fetch_add(1, Ordering::Relaxed);
                            // Copied once into a refcounted buffer, then handed to each publication
                            // by cloning the handle. The alternative - a `to_vec()` per target -
                            // allocates per call for bytes nobody mutates.
                            let shared = Bytes::copy_from_slice(packet);
                            if let Ok(sinks) = capture_sinks.lock() {
                                for sink in sinks.iter() {
                                    if !sink.open.load(Ordering::Relaxed) {
                                        continue;
                                    }
                                    // try_send, not send: dropping under backpressure keeps latency
                                    // bounded, and a closed channel means that publication's writer
                                    // task has already ended.
                                    match sink.packets.try_send(shared.clone()) {
                                        Ok(()) => {}
                                        Err(_) => {
                                            sink.stats
                                                .packets_dropped
                                                .fetch_add(1, Ordering::Relaxed);
                                        }
                                    }
                                }
                            }
                        });

                        if status.speaking != last_speaking {
                            last_speaking = status.speaking;
                            broadcast(
                                &capture_events,
                                VoiceEvent::speaking(status.speaking, status.level),
                            );
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;

        Ok(Self {
            control,
            sources,
            sinks,
            events,
            stats,
            publications: HashMap::new(),
            input_mode: config.gate.mode,
        })
    }

    pub fn control(&self) -> &Arc<Control> {
        &self.control
    }

    pub fn stats(&self) -> &Arc<EngineStats> {
        &self.stats
    }

    /// Every running publication with the slot it occupies, for reporting.
    pub fn publications(&self) -> Vec<(String, Arc<Publication>)> {
        let mut all: Vec<(String, Arc<Publication>)> = self
            .publications
            .iter()
            .map(|(slot, publication)| (slot.clone(), Arc::clone(publication)))
            .collect();
        all.sort_by(|a, b| a.0.cmp(&b.0));
        all
    }

    /// Every source in the mix, with the meter and buffer depth the playout thread sees.
    ///
    /// Buffer depth is what separates "this participant is subscribed but nothing is arriving" from
    /// "packets arrive and decode to silence" - the two look the same from a level of zero.
    pub fn source_report(&self) -> Vec<(String, f32, usize)> {
        match self.sources.lock() {
            Ok(sources) => {
                let mut report: Vec<(String, f32, usize)> = sources
                    .iter()
                    .map(|(id, source)| (id.clone(), source.level(), source.buffered_packets()))
                    .collect();
                report.sort_by(|a, b| a.0.cmp(&b.0));
                report
            }
            Err(_) => Vec::new(),
        }
    }

    pub fn publication(&self, slot: &str) -> Option<Arc<Publication>> {
        self.publications.get(slot).cloned()
    }

    pub fn is_empty(&self) -> bool {
        self.publications.is_empty()
    }

    /// Register an already-connected publication in `slot`, replacing whatever was there.
    ///
    /// Deliberately synchronous, taking a peer connection that is already up: the engine lives
    /// behind a `std::sync::Mutex`, and connecting takes a full offer/answer round trip. Doing that
    /// inside would mean holding the lock across an await - blocking mute, push-to-talk and every
    /// other command for its duration, if it compiled at all.
    pub fn attach(
        &mut self,
        slot: String,
        inner: Arc<VoicePublication>,
        on_event: tauri::ipc::Channel<VoiceEvent>,
    ) -> Arc<Publication> {
        // The old publication for this slot goes only once the new one has connected, so a failed
        // rejoin leaves the existing call alone rather than dropping it on the way out.
        self.unpublish(&slot);

        let media_session_id = inner.media_session_id.clone();
        let track_name = inner.track_name.clone();

        let (packet_tx, mut packet_rx) = tokio::sync::mpsc::channel::<Bytes>(PACKET_QUEUE);
        let (inbound_tx, mut inbound_rx) =
            tokio::sync::mpsc::channel::<(String, Packet)>(INBOUND_QUEUE);
        inner.on_audio(inbound_tx);

        let open = Arc::new(AtomicBool::new(starts_open(self.input_mode)));

        // Writer task: the peer connection is async, the capture thread is a blocking OS thread, so
        // packets cross over here rather than blocking capture on the network.
        let writer = Arc::clone(&inner);
        tokio::spawn(async move {
            while let Some(packet) = packet_rx.recv().await {
                if let Err(e) = writer.write_packet(packet).await {
                    eprintln!("[voice] write failed, ending publication: {e}");
                    break;
                }
            }
            writer.stop().await;
        });

        // Inbound task: RTP arrives keyed by mid. The mid-to-source map is written inside
        // `subscribe` before Cloudflare's answer is applied, so a packet cannot arrive for a mid the
        // map has not seen - and a packet for an unsubscribed mid is simply not ours.
        let mids: MidMap = Arc::new(Mutex::new(HashMap::new()));
        let inbound_sources = Arc::clone(&self.sources);
        let inbound_mids = Arc::clone(&mids);
        let inbound_stats = inner.stats();
        let started = Instant::now();
        tokio::spawn(async move {
            while let Some((mid, packet)) = inbound_rx.recv().await {
                let Some(id) = inbound_mids.lock().ok().and_then(|map| map.get(&mid).cloned())
                else {
                    // Counted rather than only skipped. This `continue` is where a mid-mapping
                    // fault turns into silence: the packets arrive, the connection is healthy, and
                    // every layer above reports success while the audio goes in the bin.
                    inbound_stats.rtp_unmapped.fetch_add(1, Ordering::Relaxed);
                    continue;
                };
                let arrival_ms = started.elapsed().as_millis() as u64;
                if let Ok(mut sources) = inbound_sources.lock() {
                    if let Some(source) = sources.get_mut(&id) {
                        source.push(packet, arrival_ms);
                        inbound_stats.rtp_routed.fetch_add(1, Ordering::Relaxed);
                    } else {
                        // Mapped to a source that is no longer in the mix - the same silent loss,
                        // one layer further down.
                        inbound_stats.rtp_unmapped.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
        });

        if let Ok(mut sinks) = self.sinks.lock() {
            sinks.push(Sink {
                slot: slot.clone(),
                open: Arc::clone(&open),
                packets: packet_tx,
                stats: inner.stats(),
            });
        }
        if let Ok(mut events) = self.events.lock() {
            events.push((slot.clone(), on_event));
        }

        let publication = Arc::new(Publication {
            inner,
            mids,
            subscribed: Mutex::new(HashSet::new()),
            open,
            sources: Arc::clone(&self.sources),
            control: Arc::clone(&self.control),
            media_session_id,
            track_name,
        });
        self.publications.insert(slot, Arc::clone(&publication));
        self.refresh_gate();
        publication
    }

    /// Tear down the publication in `slot`, leaving every other call untouched.
    pub fn unpublish(&mut self, slot: &str) {
        let Some(publication) = self.publications.remove(slot) else {
            return;
        };
        // Its participants leave the shared mix; everyone else's stay.
        publication.unsubscribe_all();
        // Dropping the sender ends the writer task, which stops the peer connection on its way out.
        if let Ok(mut sinks) = self.sinks.lock() {
            sinks.retain(|sink| sink.slot != slot);
        }
        if let Ok(mut events) = self.events.lock() {
            events.retain(|(existing, _)| existing != slot);
        }
        self.refresh_gate();
    }

    /// Apply a settings change to the capture chain, and to every publication's routing.
    ///
    /// The input mode has to reach the publications as well as the chain: switching to push-to-talk
    /// mid-call must close them all until a key is pressed, and switching away must reopen them, or
    /// the user's microphone silently stops working in whichever direction they moved.
    pub fn set_config(&mut self, config: ChainConfig) {
        self.input_mode = config.gate.mode;
        self.control.set_config(config);
        let open = starts_open(self.input_mode);
        for publication in self.publications.values() {
            publication.set_open(open);
        }
        self.refresh_gate();
    }

    /// Recompute the engine-wide gate from the publications.
    ///
    /// The microphone is live if *any* target wants it. Routing then decides who actually receives
    /// the audio, which is how proximity push-to-talk stays independent of the guild channel's while
    /// sharing one capture.
    pub fn refresh_gate(&self) {
        let wanted = self.publications.values().any(|p| p.open());
        self.control.set_ptt_down(wanted);
    }

    pub fn stop(&mut self) {
        let slots: Vec<String> = self.publications.keys().cloned().collect();
        for slot in slots {
            self.unpublish(&slot);
        }
        self.control.stop();
    }
}

fn broadcast(events: &Events, event: VoiceEvent) {
    if let Ok(list) = events.lock() {
        for (_, channel) in list.iter() {
            let _ = channel.send(event.clone());
        }
    }
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
    fn push_to_talk_publications_start_closed_and_others_start_open() {
        // The whole per-publication routing scheme rests on this. Backwards, a push-to-talk user
        // transmits from the moment they join, or a voice-activity user is inaudible until they
        // press a key they never bound.
        assert!(!starts_open(InputMode::PushToTalk));
        assert!(starts_open(InputMode::VoiceActivity));
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
    fn forgetting_a_source_is_itself_a_gain_change() {
        let control = Control::default();
        control.set_gain("a".into(), 0.5);
        control.take_gains();
        control.forget_source("a");
        let gains = control.take_gains().expect("removal must be reported too");
        assert!(!gains.contains_key("a"));
    }

    #[test]
    fn master_volume_starts_at_unity() {
        // The one field whose zero value is wrong. A derived `Default` would start every session
        // silent, and it would look like a broken output device rather than a settings bug.
        assert_eq!(Control::default().master(), 1.0);
    }

    #[test]
    fn master_volume_round_trips_and_clamps() {
        let control = Control::default();
        control.set_master(0.25);
        assert_eq!(control.master(), 0.25);

        control.set_master(4.0);
        assert_eq!(control.master(), 1.0, "above unity is clamped, not amplified");

        control.set_master(-1.0);
        assert_eq!(control.master(), 0.0);
    }

    #[test]
    fn a_nan_master_volume_is_ignored() {
        // It would multiply the whole mix to NaN, silencing everyone at once with no way back
        // except rejoining - so the last good value is kept instead.
        let control = Control::default();
        control.set_master(0.5);
        control.set_master(f32::NAN);
        assert_eq!(control.master(), 0.5);
    }

    #[test]
    fn positions_are_only_reported_once_per_change() {
        // Positions arrive on every movement tick. The playout thread asks each frame, so handing
        // it the table unconditionally would put a lock on the audio path 100 times a second.
        let control = Control::default();
        assert!(control.take_positions().is_none());

        control.set_position("a".into(), Some(Position { x: 1.0, y: 0.0, z: 0.0 }));
        let positions = control.take_positions().expect("a move was pending");
        assert!(positions.contains_key("a"));
        assert!(control.take_positions().is_none(), "the move was consumed");
    }

    #[test]
    fn un_placing_a_participant_is_itself_a_change() {
        let control = Control::default();
        control.set_position("a".into(), Some(Position { x: 1.0, y: 0.0, z: 0.0 }));
        control.take_positions();

        control.set_position("a".into(), None);
        let positions = control.take_positions().expect("un-placing must be reported");
        assert_eq!(positions.get("a"), Some(&None));
    }

    #[test]
    fn leaving_the_call_forgets_the_position_entirely() {
        // Distinct from un-placing: the entry goes away rather than becoming None, so the mixer is
        // not left holding spatial state for somebody who is gone.
        let control = Control::default();
        control.set_position("a".into(), Some(Position { x: 1.0, y: 0.0, z: 0.0 }));
        control.take_positions();

        control.forget_source("a");
        let positions = control.take_positions().expect("removal must be reported");
        assert!(!positions.contains_key("a"));
    }

    #[test]
    fn a_departed_source_is_reported_to_the_mixer_exactly_once() {
        // The mixer holds a convolution tail per placed source. Without this the tail outlives the
        // participant, and re-reporting it every frame would clear state a returning participant
        // had just rebuilt.
        let control = Control::default();
        assert!(control.take_departed().is_empty());

        control.forget_source("a");
        assert_eq!(control.take_departed(), vec!["a".to_string()]);
        assert!(control.take_departed().is_empty(), "the removal was consumed");
    }

    #[test]
    fn a_nonsensical_spatial_model_never_reaches_the_mixer() {
        // Zero or NaN would silence every placed source at once, which looks exactly like the game
        // having stopped sending positions - so a bad model is dropped and the caller told, rather
        // than half-applied.
        let control = Control::default();
        let good = SpatialModel { max_distance: 40.0, ..SpatialModel::default() };
        control.set_spatial_model(good).expect("a usable model");
        assert_eq!(control.take_spatial_model(), Some(good));

        for bad in [0.0, -5.0, f32::NAN, f32::INFINITY] {
            let model = SpatialModel { max_distance: bad, ..SpatialModel::default() };
            assert!(control.set_spatial_model(model).is_err(), "accepted {bad}");
            assert!(control.take_spatial_model().is_none(), "{bad} reached the mixer");
        }
    }

    #[test]
    fn the_spatial_model_starts_absent_rather_than_defaulted() {
        // The mixer already starts on its own default. Reporting one here on the first frame would
        // read as a configuration step that had happened when it had not.
        assert!(Control::default().take_spatial_model().is_none());
    }

    #[test]
    fn a_spatial_model_is_delivered_exactly_once() {
        // Set once per Isle connect, read every 10 ms. Handing it over repeatedly would rebuild
        // nothing but would make the dirty flag pointless.
        let control = Control::default();
        control.set_spatial_model(SpatialModel::default()).unwrap();
        assert!(control.take_spatial_model().is_some());
        assert!(control.take_spatial_model().is_none(), "the change was consumed");
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
        use crate::media::voice::gate::GateConfig;
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
            input_gain: 1.0,
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
