//! The speaker end of the voice pipeline.
//!
//! Deliberately the mirror image of `capture.rs`: the same device-by-name lookup, the same ring, the
//! same real-time discipline in the callback. The ring is what lets the mixer run on its own 10 ms
//! thread while the device asks for whatever buffer size it likes.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use super::ring::{self, RingReader, RingWriter};

/// Ring depth. Deeper than the capture ring: an output underrun is audible as a gap, where a capture
/// overrun costs one frame nobody notices.
const RING_MS: u32 = 300;

pub struct OutputStream(cpal::Stream);

// Same reasoning as `capture::InputStream`: cpal's handle is not `Send` on every host, but it is
// moved exactly once, onto the thread that owns it for its whole life.
unsafe impl Send for OutputStream {}

impl OutputStream {
    #[allow(dead_code)]
    pub fn pause(&self) {
        let _ = self.0.pause();
    }

    #[allow(dead_code)]
    pub fn play(&self) {
        let _ = self.0.play();
    }
}

/// The write half. Owned by the playout thread; the device callback owns the read half.
pub struct PlayoutSink {
    writer: RingWriter,
    underruns: Arc<AtomicU64>,
    /// Only ever `Some` in tests, where there is no device to own the read half.
    #[cfg(test)]
    test_reader: Option<RingReader>,
}

impl PlayoutSink {
    /// Hand the mixer's interleaved stereo frame to the device.
    pub fn write_stereo(&mut self, frame: &[f32]) {
        self.writer.write(frame);
    }

    /// How many times the device asked for samples that were not there.
    ///
    /// A count that climbs during a call means the mixer thread is not keeping up. That is a bug to
    /// find, not a number to tune the ring against.
    #[allow(dead_code)]
    pub fn underruns(&self) -> u64 {
        self.underruns.load(Ordering::Relaxed)
    }
}

/// Spread interleaved audio across the device's channel count.
///
/// `src_channels` is always 2 in practice - the mixer's output - but the destination is whatever the
/// device reports, which on a surround card is 6 or 8.
pub fn upmix(input: &[f32], src_channels: usize, dst_channels: usize, out: &mut Vec<f32>) {
    out.clear();
    if dst_channels == 0 || src_channels == 0 {
        return;
    }
    let finite = |s: f32| if s.is_finite() { s } else { 0.0 };

    for frame in input.chunks_exact(src_channels) {
        if dst_channels == 1 {
            let sum: f32 = frame.iter().copied().map(finite).sum();
            out.push(sum / src_channels as f32);
            continue;
        }
        for channel in 0..dst_channels {
            // Beyond the source's channels, stay silent. Copying the front pair into the surrounds
            // sounds like a phasey chorus, and into a subwoofer channel it sounds worse.
            out.push(frame.get(channel).copied().map(finite).unwrap_or(0.0));
        }
    }
}

/// Open the selected output device.
///
/// Returns the stream (which must be kept alive for audio to flow), the sink to write mixed frames
/// into, and the device's own sample rate.
pub fn open(device_id: Option<&str>) -> Result<(OutputStream, PlayoutSink, u32), String> {
    let host = cpal::default_host();

    // By name, falling back to the default, for the same reasons as `capture::open`: cpal exposes no
    // stable id, and a device that has been unplugged should not fail the call.
    let device = match device_id {
        Some(id) if id != "default" => host
            .output_devices()
            .map_err(|e| e.to_string())?
            .find(|d| d.name().ok().as_deref() == Some(id))
            .or_else(|| host.default_output_device()),
        _ => host.default_output_device(),
    }
    .ok_or_else(|| "no output device available".to_string())?;

    let supported = device
        .default_output_config()
        .map_err(|e| format!("no default output config: {e}"))?;
    let sample_rate = supported.sample_rate().0;
    let channels = supported.channels() as usize;

    let config = cpal::StreamConfig {
        channels: supported.channels(),
        sample_rate: supported.sample_rate(),
        // Let the host choose. Demanding a size is how you get a device that refuses to open, and
        // the ring already decouples us from whatever it picks.
        buffer_size: cpal::BufferSize::Default,
    };

    let (writer, mut reader) = ring::channel(RING_MS);
    let underruns = Arc::new(AtomicU64::new(0));
    let callback_underruns = Arc::clone(&underruns);

    // Sized once, up front, so the callback never grows either buffer. 200 ms is far beyond any real
    // host buffer; `fill` clamps to it rather than reallocating if that ever stops being true.
    let budget = (sample_rate as usize / 5).max(4096);
    let mut scratch = Scratch {
        stereo: vec![0.0; budget * 2],
        spread: Vec::with_capacity(budget * channels.max(2)),
    };

    let stream = device
        .build_output_stream(
            &config,
            move |data: &mut [f32], _| {
                fill(
                    data,
                    channels,
                    &mut reader,
                    &mut scratch,
                    &callback_underruns,
                );
            },
            |err| eprintln!("[voice] output stream error: {err}"),
            None,
        )
        .map_err(|e| format!("could not open the output stream: {e}"))?;

    stream.play().map_err(|e| e.to_string())?;

    Ok((
        OutputStream(stream),
        PlayoutSink {
            writer,
            underruns,
            #[cfg(test)]
            test_reader: None,
        },
        sample_rate,
    ))
}

/// The entire real-time budget: pull interleaved stereo out of the ring and spread it across the
/// device's channels. No allocation, no lock, no syscall.
///
/// Goes through `upmix` rather than repeating its logic, so the function the tests exercise is the
/// one the device actually runs. Both `Vec`s are preallocated by `open`; `upmix` clears and refills
/// them, which reuses that capacity instead of growing.
struct Scratch {
    stereo: Vec<f32>,
    spread: Vec<f32>,
}

fn fill(
    data: &mut [f32],
    channels: usize,
    reader: &mut RingReader,
    scratch: &mut Scratch,
    underruns: &AtomicU64,
) {
    if channels == 0 {
        return;
    }
    let device_frames = (data.len() / channels).min(scratch.stereo.len() / 2);
    // The ring holds interleaved stereo, so two samples per device frame.
    let wanted = device_frames * 2;
    let got = reader.pop_into(&mut scratch.stereo[..wanted]);

    if got < wanted {
        underruns.fetch_add(1, Ordering::Relaxed);
        scratch.stereo[got..wanted].fill(0.0);
    }

    upmix(&scratch.stereo[..wanted], 2, channels, &mut scratch.spread);

    let n = data.len().min(scratch.spread.len());
    data[..n].copy_from_slice(&scratch.spread[..n]);
    // Only reachable if the host asked for more than the scratch was sized for; silence beats
    // whatever the driver left in the tail.
    data[n..].fill(0.0);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_sink() -> PlayoutSink {
        let (writer, reader) = ring::channel(RING_MS);
        PlayoutSink {
            writer,
            underruns: Arc::new(AtomicU64::new(0)),
            test_reader: Some(reader),
        }
    }

    impl PlayoutSink {
        /// Drive the device callback's logic without a device.
        fn fill_for_test(&mut self, data: &mut [f32], channels: usize) {
            let mut scratch = Scratch {
                stereo: vec![0.0; data.len().max(8) * 2],
                spread: Vec::with_capacity(data.len().max(8) * channels.max(2)),
            };
            let reader = self.test_reader.as_mut().expect("test sink");
            fill(data, channels, reader, &mut scratch, &self.underruns);
        }
    }

    #[test]
    fn stereo_to_stereo_is_unchanged() {
        let mut out = Vec::new();
        upmix(&[0.1, -0.2, 0.3, -0.4], 2, 2, &mut out);
        assert_eq!(out, vec![0.1, -0.2, 0.3, -0.4]);
    }

    #[test]
    fn stereo_collapses_to_mono_by_averaging() {
        let mut out = Vec::new();
        upmix(&[1.0, 0.0, 0.5, 0.5], 2, 1, &mut out);
        assert_eq!(out, vec![0.5, 0.5]);
    }

    #[test]
    fn stereo_spreads_across_a_surround_device() {
        // A 6-channel device must not be handed 2-channel data: the host either refuses the stream
        // or plays the mix into the wrong speakers.
        let mut out = Vec::new();
        upmix(&[0.2, 0.4], 2, 6, &mut out);
        assert_eq!(out, vec![0.2, 0.4, 0.0, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn a_non_finite_sample_never_survives_the_upmix() {
        let mut out = Vec::new();
        upmix(&[f32::NAN, f32::INFINITY, 0.5, 0.5], 2, 2, &mut out);
        assert_eq!(out, vec![0.0, 0.0, 0.5, 0.5]);
    }

    #[test]
    fn zero_destination_channels_produces_nothing_rather_than_panicking() {
        let mut out = Vec::new();
        upmix(&[0.1, 0.2], 2, 0, &mut out);
        assert!(out.is_empty());
    }

    #[test]
    fn an_empty_ring_reads_as_silence_and_counts_an_underrun() {
        let mut sink = test_sink();
        assert_eq!(sink.underruns(), 0);
        let mut buf = vec![9.0f32; 8];
        sink.fill_for_test(&mut buf, 2);
        assert!(
            buf.iter().all(|s| *s == 0.0),
            "an underrun must emit silence, not whatever was in the buffer"
        );
        assert_eq!(sink.underruns(), 1);
    }

    #[test]
    fn written_frames_come_back_out_in_order() {
        let mut sink = test_sink();
        sink.write_stereo(&[0.1, 0.2, 0.3, 0.4]);
        let mut buf = vec![0.0f32; 4];
        sink.fill_for_test(&mut buf, 2);
        assert_eq!(buf, vec![0.1, 0.2, 0.3, 0.4]);
        assert_eq!(sink.underruns(), 0);
    }

    #[test]
    fn a_partial_ring_fills_the_rest_with_silence() {
        // The device buffer must always be filled completely; a short read becomes a gap, not a
        // refusal, and the gap is counted so it can be found later.
        let mut sink = test_sink();
        sink.write_stereo(&[0.5, 0.6]);
        let mut buf = vec![9.0f32; 4];
        sink.fill_for_test(&mut buf, 2);
        assert_eq!(buf, vec![0.5, 0.6, 0.0, 0.0]);
        assert_eq!(sink.underruns(), 1);
    }

    #[test]
    fn a_non_finite_sample_never_reaches_the_device() {
        let mut sink = test_sink();
        sink.write_stereo(&[f32::NAN, 0.5]);
        let mut buf = vec![0.0f32; 2];
        sink.fill_for_test(&mut buf, 2);
        assert_eq!(buf, vec![0.0, 0.5]);
    }

    #[test]
    fn a_mono_device_still_gets_a_full_buffer() {
        // Not the common case, but a device reporting one channel must not be handed a half-filled
        // buffer - the tail would be whatever the driver left there.
        let mut sink = test_sink();
        sink.write_stereo(&[0.4, 0.4, 0.2, 0.2]);
        let mut buf = vec![9.0f32; 2];
        sink.fill_for_test(&mut buf, 1);
        assert_eq!(buf.len(), 2);
        assert!(buf.iter().all(|s| s.is_finite() && *s != 9.0));
    }
}
