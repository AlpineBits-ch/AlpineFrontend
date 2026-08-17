import {LocalStreamChunk} from '../screen-publisher-host';

/**
 * The wire format the Rust publisher uses for the sharer's own copy of the encoded stream.
 *
 * <p><b>Why there is a format at all.</b> `VideoDecoder` needs three things per access unit: the
 * bytes, whether it is a keyframe, and its presentation timestamp. Only the bytes can be inferred
 * from the payload; the other two have to travel with it. Sending a JSON object with a base64 field
 * would have been the obvious shape and is exactly what this avoids - base64 is a third more IPC for
 * a payload that is the share's whole bitrate, and `Channel` serialises small `Raw` bodies as a JSON
 * array of numbers, which is four bytes per byte. A raw body with a fixed header is one binary fetch
 * per frame and no re-encoding on either side.</p>
 *
 * <p><b>This file and `pump.rs` move together.</b> The layout is written by
 * `FramePump::emit_local_stream` and read here, and nothing type-checks across that boundary. A
 * change to one that is not made to the other produces a stream that decodes to garbage rather than
 * a build error, so `local-stream-framing.spec.ts` pins the byte offsets against the constants Rust
 * declares.</p>
 */

/** Flags byte, then a little-endian u64 of microseconds. The access unit follows. */
export const LOCAL_STREAM_HEADER_LEN = 9;

/** Bit 0 of the flags byte: this access unit is an IDR. */
const FLAG_KEYFRAME = 1;

/**
 * Read one framed access unit, or null if it is too short to be one.
 *
 * <p>Null rather than a throw, and null rather than a zero-length chunk: a truncated message is a
 * message that cannot be decoded, and handing `VideoDecoder` an empty payload puts the decoder into
 * an error state that costs the whole picture rather than one frame. The caller drops it and waits
 * for the next keyframe.</p>
 *
 * <p>The payload is a view over the received buffer rather than a copy. `VideoDecoder.decode` reads
 * it synchronously, so there is nothing to outlive - and copying the share's whole bitrate once per
 * frame is exactly the cost this format exists to avoid.</p>
 */
export function parseLocalStreamChunk(buffer: ArrayBuffer): LocalStreamChunk | null {
    if (buffer.byteLength <= LOCAL_STREAM_HEADER_LEN) return null;

    const header = new DataView(buffer, 0, LOCAL_STREAM_HEADER_LEN);
    return {
        keyframe: (header.getUint8(0) & FLAG_KEYFRAME) !== 0,
        // getBigUint64 rather than two 32-bit reads: the value is microseconds since the share
        // started, which passes 2^32 after roughly 71 minutes - well inside one screen share.
        // Narrowed to a number afterwards because that is what `EncodedVideoChunk` takes, and
        // 2^53 microseconds is 285 years.
        timestampUs: Number(header.getBigUint64(1, true)),
        data: new Uint8Array(buffer, LOCAL_STREAM_HEADER_LEN),
    };
}
