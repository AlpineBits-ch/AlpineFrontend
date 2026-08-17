/**
 * AudioWorklet processor for Rust-captured microphone/loopback audio.
 *
 * Rust sends f32-LE PCM chunks via the port in ~40 ms batches (1920 samples
 * at 48 kHz). The processor drains a FIFO buffer every render quantum
 * (128 samples) and outputs silence when the buffer is empty.
 *
 * Pre-buffering: playback is held until MIN_BUFFER_SAMPLES are queued.
 * This absorbs the inherent IPC jitter between Tauri Channel delivers so
 * that the buffer does not run dry and produce crackling during normal use.
 * 80 ms (3840 samples) covers two full Rust batch intervals.
 */
const MIN_BUFFER_SAMPLES = 3840; // 80 ms @ 48 kHz

class AudioCaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        /** @type {Float32Array[]} */
        this._chunks = [];
        this._chunkOffset = 0;
        this._buffered = 0;
        this._ready = false;

        this.port.onmessage = ({data}) => {
            if (data.type === 'samples' && data.buffer instanceof ArrayBuffer) {
                const arr = new Float32Array(data.buffer);
                this._chunks.push(arr);
                this._buffered += arr.length;
                if (!this._ready && this._buffered >= MIN_BUFFER_SAMPLES) {
                    this._ready = true;
                }
            }
        };
    }

    /**
     * @param {Float32Array[][]} _inputs
     * @param {Float32Array[][]} outputs
     */
    process(_inputs, outputs) {
        const out = outputs[0][0];

        if (!this._ready) {
            out.fill(0);
            return true;
        }

        let written = 0;

        while (written < out.length && this._chunks.length > 0) {
            const chunk = this._chunks[0];
            const available = chunk.length - this._chunkOffset;
            const needed = out.length - written;
            const take = Math.min(available, needed);

            out.set(chunk.subarray(this._chunkOffset, this._chunkOffset + take), written);
            written += take;
            this._chunkOffset += take;
            this._buffered -= take;

            if (this._chunkOffset >= chunk.length) {
                this._chunks.shift();
                this._chunkOffset = 0;
            }
        }

        // Fill remainder with silence when buffer is empty
        if (written < out.length) {
            out.fill(0, written);
        }

        return true;
    }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);
