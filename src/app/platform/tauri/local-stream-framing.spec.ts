import {describe, expect, it} from 'vitest';
import {LOCAL_STREAM_HEADER_LEN, parseLocalStreamChunk} from './local-stream-framing';

/**
 * The wire format between `FramePump::emit_local_stream` and the webview's decoder.
 *
 * <p>Nothing type-checks across that boundary, and getting it wrong does not fail a build - it
 * produces a picture that decodes to garbage, or one that decodes fine and plays at the wrong rate.
 * These are the byte offsets, pinned, so a change on the Rust side that is not made here is caught
 * by a test rather than by looking at a smeared tile.</p>
 */

/** Builds a message the way Rust does: flags byte, u64 LE microseconds, then the access unit. */
function framed(keyframe: boolean, timestampUs: bigint, payload: number[]): ArrayBuffer {
    const buffer = new ArrayBuffer(LOCAL_STREAM_HEADER_LEN + payload.length);
    const view = new DataView(buffer);
    view.setUint8(0, keyframe ? 1 : 0);
    view.setBigUint64(1, timestampUs, true);
    new Uint8Array(buffer).set(payload, LOCAL_STREAM_HEADER_LEN);
    return buffer;
}

describe('parseLocalStreamChunk', () => {
    it('reads the keyframe flag, the timestamp and the access unit', () => {
        const chunk = parseLocalStreamChunk(framed(true, 33_366n, [0, 0, 0, 1, 0x65]));

        expect(chunk).toEqual({
            keyframe: true,
            timestampUs: 33_366,
            data: new Uint8Array([0, 0, 0, 1, 0x65]),
        });
    });

    it('reads a delta frame as a delta', () => {
        // `EncodedVideoChunk` takes the type as a hard fact: a delta announced as a keyframe makes
        // the decoder start on frames whose references it does not have.
        expect(parseLocalStreamChunk(framed(false, 0n, [9]))?.keyframe).toBe(false);
    });

    /**
     * The header is deliberately eight bytes wide. Microseconds pass 2^32 after about 71 minutes,
     * which is well inside one screen share - a 32-bit field would wrap mid-stream and hand the
     * decoder timestamps that go backwards.
     */
    it('reads a timestamp past the 32-bit boundary', () => {
        const twoHours = 2n * 3600n * 1_000_000n;

        expect(parseLocalStreamChunk(framed(false, twoHours, [1]))?.timestampUs).toBe(7_200_000_000);
    });

    it('ignores the unused flag bits rather than reading them as a keyframe', () => {
        const buffer = framed(false, 0n, [1]);
        new DataView(buffer).setUint8(0, 0b1111_1110);

        expect(parseLocalStreamChunk(buffer)?.keyframe).toBe(false);
    });

    /**
     * A truncated message is one lost frame, and must stay one lost frame: handing `VideoDecoder`
     * an empty payload puts it into an error state, which costs the whole picture rather than a
     * frame of it. The caller drops the null and waits for the next keyframe.
     */
    it('rejects a message with no room for an access unit', () => {
        expect(parseLocalStreamChunk(new ArrayBuffer(LOCAL_STREAM_HEADER_LEN))).toBeNull();
        expect(parseLocalStreamChunk(new ArrayBuffer(0))).toBeNull();
        expect(parseLocalStreamChunk(new ArrayBuffer(LOCAL_STREAM_HEADER_LEN - 1))).toBeNull();
    });
});
