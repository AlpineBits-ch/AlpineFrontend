/**
 * AudioWorklet processor for Rust-captured microphone audio.
 *
 * Rust sends base64-encoded f32-LE PCM chunks via the port. The processor
 * drains a FIFO buffer on every render quantum (128 samples) and outputs
 * silence when the buffer is empty (prevents glitches during IPC gaps).
 */
class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    /** @type {Float32Array[]} */
    this._chunks = [];
    this._chunkOffset = 0;

    this.port.onmessage = ({ data }) => {
      if (data.type === 'samples' && data.buffer instanceof ArrayBuffer) {
        this._chunks.push(new Float32Array(data.buffer));
      }
    };
  }

  /**
   * @param {Float32Array[][]} _inputs
   * @param {Float32Array[][]} outputs
   */
  process(_inputs, outputs) {
    const out = outputs[0][0];
    let written = 0;

    while (written < out.length && this._chunks.length > 0) {
      const chunk = this._chunks[0];
      const available = chunk.length - this._chunkOffset;
      const needed = out.length - written;
      const take = Math.min(available, needed);

      out.set(chunk.subarray(this._chunkOffset, this._chunkOffset + take), written);
      written += take;
      this._chunkOffset += take;

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
