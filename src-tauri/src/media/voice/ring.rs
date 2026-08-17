//! The hop between a device callback and a worker thread.
//!
//! Both cpal callbacks run on an OS audio thread with a hard deadline: miss it and the user hears a
//! dropout. So the callback may not allocate, may not lock, and may not block - which rules out
//! `Vec` growth, mutexes, and channels that park. This is a preallocated lock-free ring, and the
//! only thing the callback does is copy into it.
//!
//! On overrun the *newest* samples are dropped rather than the oldest. For live voice that is the
//! right way round: keeping stale audio and discarding current audio would trade a brief glitch for
//! permanently added latency that never recovers.

use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};

use super::{FRAME, SAMPLE_RATE};

/// Write end, owned by the device callback.
pub struct RingWriter {
    producer: HeapProd<f32>,
    overruns: u64,
}

/// Read end, owned by the worker thread.
pub struct RingReader {
    consumer: HeapCons<f32>,
}

/// Create a ring holding `capacity_ms` of 48 kHz mono audio.
pub fn channel(capacity_ms: u32) -> (RingWriter, RingReader) {
    channel_samples((SAMPLE_RATE as usize * capacity_ms as usize) / 1000)
}

/// Create a ring holding exactly `samples` samples.
///
/// For the ends that are neither mono nor at the pipeline rate. Playout is both: it carries
/// interleaved stereo at whatever rate the output device runs at, so expressing its depth in
/// milliseconds of 48 kHz mono would understate it by a factor of two times the rate ratio - and
/// silently, as a shorter buffer rather than an error.
pub fn channel_samples(samples: usize) -> (RingWriter, RingReader) {
    // Never smaller than one frame: a ring that cannot hold a single frame would never let the
    // reader make progress at all.
    let (producer, consumer) = HeapRb::<f32>::new(samples.max(FRAME)).split();
    (
        RingWriter {
            producer,
            overruns: 0,
        },
        RingReader { consumer },
    )
}

impl RingWriter {
    /// Copy samples in, returning how many were accepted.
    ///
    /// A short return is backpressure, not an error: the reader is behind and the excess is gone.
    pub fn write(&mut self, samples: &[f32]) -> usize {
        let written = self.producer.push_slice(samples);
        self.overruns += (samples.len() - written) as u64;
        written
    }

    /// Total samples dropped for want of space, for diagnostics. A number that climbs during a call
    /// means the consuming thread is not keeping up.
    pub fn overruns(&self) -> u64 {
        self.overruns
    }
}

impl RingReader {
    /// Pop exactly one frame, or nothing.
    ///
    /// All-or-nothing on purpose: a partial frame would silently misalign every stage downstream,
    /// and every one of them is defined in terms of whole 10 ms frames.
    pub fn read_frame(&mut self, out: &mut [f32]) -> bool {
        if out.len() != FRAME || self.consumer.occupied_len() < FRAME {
            return false;
        }
        self.consumer.pop_slice(out) == FRAME
    }

    pub fn available_frames(&self) -> usize {
        self.consumer.occupied_len() / FRAME
    }

    /// Pop as much as will fit, returning how many samples were actually available.
    ///
    /// The opposite policy to `read_frame`, and deliberately so: the output device callback is
    /// handed a buffer it must fill completely, whatever size the host chose. Refusing a partial
    /// read there would mean emitting nothing at all, so a short read becomes silence instead - a
    /// gap the caller can count, rather than a stall.
    pub fn pop_into(&mut self, out: &mut [f32]) -> usize {
        self.consumer.pop_slice(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_frame_written_is_a_frame_read() {
        let (mut w, mut r) = channel(100);
        let input: Vec<f32> = (0..FRAME).map(|i| i as f32 / FRAME as f32).collect();
        assert_eq!(w.write(&input), FRAME);

        let mut out = vec![0.0f32; FRAME];
        assert!(r.read_frame(&mut out));
        assert_eq!(out, input);
    }

    #[test]
    fn a_partial_frame_is_not_readable() {
        let (mut w, mut r) = channel(100);
        w.write(&vec![0.5f32; FRAME - 1]);

        let mut out = vec![0.0f32; FRAME];
        assert!(!r.read_frame(&mut out), "a partial frame must not be popped");
        assert_eq!(r.available_frames(), 0);

        // One more sample completes it.
        w.write(&[0.5]);
        assert!(r.read_frame(&mut out));
    }

    #[test]
    fn an_empty_ring_reads_nothing() {
        let (_w, mut r) = channel(100);
        let mut out = vec![0.0f32; FRAME];
        assert!(!r.read_frame(&mut out));
    }

    #[test]
    fn overrun_drops_the_newest_and_is_counted() {
        // Two frames of capacity, three frames of input.
        let (mut w, mut r) = channel(20);
        let first = vec![1.0f32; FRAME];
        let second = vec![2.0f32; FRAME];
        let third = vec![3.0f32; FRAME];

        assert_eq!(w.write(&first), FRAME);
        assert_eq!(w.write(&second), FRAME);
        assert_eq!(w.write(&third), 0, "the ring is full, so nothing more fits");
        assert_eq!(w.overruns(), FRAME as u64);

        // The two oldest frames survived; the newest was the one discarded.
        let mut out = vec![0.0f32; FRAME];
        assert!(r.read_frame(&mut out));
        assert_eq!(out[0], 1.0);
        assert!(r.read_frame(&mut out));
        assert_eq!(out[0], 2.0);
    }

    #[test]
    fn reading_frees_space_for_more_writes() {
        let (mut w, mut r) = channel(20);
        w.write(&vec![1.0f32; FRAME]);
        w.write(&vec![2.0f32; FRAME]);

        let mut out = vec![0.0f32; FRAME];
        assert!(r.read_frame(&mut out));
        assert_eq!(w.write(&vec![3.0f32; FRAME]), FRAME);
    }

    #[test]
    fn capacity_is_expressed_in_milliseconds() {
        let (mut w, r) = channel(100);
        // 100 ms at 48 kHz is 4800 samples, which is ten frames.
        assert_eq!(w.write(&vec![0.0f32; 4800]), 4800);
        assert_eq!(r.available_frames(), 10);
    }

    #[test]
    fn a_wrongly_sized_output_buffer_is_refused() {
        let (mut w, mut r) = channel(100);
        w.write(&vec![0.5f32; FRAME]);
        let mut out = vec![0.0f32; FRAME - 1];
        assert!(!r.read_frame(&mut out));
    }
}
