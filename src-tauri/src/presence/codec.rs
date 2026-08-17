//! Discord RPC framing: `u32 LE opcode` ‖ `u32 LE payload_length` ‖ UTF-8 JSON.
//!
//! Verified against OpenAsar's `arrpc` (`src/transports/ipc.js`), which is a production
//! reimplementation of the same server.
//!
//! ## The length prefix is attacker-controlled
//!
//! Every byte that reaches this module came off a socket with no authentication that any process
//! running as the user can open. [`read_packet`] therefore checks the declared length against
//! [`MAX_FRAME_LEN`] **before** it allocates anything, and returns [`CodecError::TooLarge`] without
//! reading a single payload byte. A reader that allocates first is a one-line remote OOM: a
//! four-byte write of `0xFFFFFFFF` asks for 4 GiB.
//!
//! Nothing here is cancel-safe -a `read_packet` future dropped mid-frame loses the bytes it had
//! consumed. Callers must only race it against a shutdown signal they intend to be terminal (see
//! [`super::ipc`]).

use std::io;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// The largest payload we will read. Discord's own frames are a few hundred bytes; 64 KiB is
/// generous by two orders of magnitude and still bounded.
pub const MAX_FRAME_LEN: u32 = 64 * 1024;

/// Bytes of fixed header before every payload.
pub const HEADER_LEN: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Opcode {
    Handshake,
    Frame,
    Close,
    Ping,
    Pong,
}

impl Opcode {
    pub fn from_u32(value: u32) -> Option<Self> {
        match value {
            0 => Some(Self::Handshake),
            1 => Some(Self::Frame),
            2 => Some(Self::Close),
            3 => Some(Self::Ping),
            4 => Some(Self::Pong),
            _ => None,
        }
    }

    pub fn as_u32(self) -> u32 {
        match self {
            Self::Handshake => 0,
            Self::Frame => 1,
            Self::Close => 2,
            Self::Ping => 3,
            Self::Pong => 4,
        }
    }
}

/// One frame as it came off the wire.
///
/// The opcode is kept as the raw `u32` rather than an [`Opcode`], because an unrecognised opcode is
/// a thing the state machine has to *decide* about, not a parse failure -and in proxy mode the
/// bytes are relayed verbatim regardless of whether we understand them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Packet {
    pub opcode: u32,
    pub payload: Vec<u8>,
}

impl Packet {
    pub fn new(opcode: Opcode, payload: Vec<u8>) -> Self {
        Self {
            opcode: opcode.as_u32(),
            payload,
        }
    }

    /// The bytes as they go back on the wire.
    pub fn encode(&self) -> Vec<u8> {
        encode(self.opcode, &self.payload)
    }
}

#[derive(Debug)]
pub enum CodecError {
    /// The peer closed cleanly on a frame boundary. Ordinary, not a fault.
    Eof,
    /// The peer closed part-way through a header or payload.
    Truncated,
    /// The declared length exceeds [`MAX_FRAME_LEN`]. Nothing was allocated.
    TooLarge(u32),
    Io(io::Error),
}

impl std::fmt::Display for CodecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Eof => write!(f, "peer closed"),
            Self::Truncated => write!(f, "truncated frame"),
            Self::TooLarge(len) => write!(f, "frame length {len} exceeds {MAX_FRAME_LEN}"),
            Self::Io(e) => write!(f, "io error: {e}"),
        }
    }
}

impl From<io::Error> for CodecError {
    fn from(value: io::Error) -> Self {
        Self::Io(value)
    }
}

/// Serializes one frame. Payload length is a `usize` at the call site and a `u32` on the wire;
/// anything that would not fit is a bug on our side, so it is capped rather than wrapped.
pub fn encode(opcode: u32, payload: &[u8]) -> Vec<u8> {
    let len = payload.len().min(MAX_FRAME_LEN as usize) as u32;
    let mut out = Vec::with_capacity(HEADER_LEN + len as usize);
    out.extend_from_slice(&opcode.to_le_bytes());
    out.extend_from_slice(&len.to_le_bytes());
    out.extend_from_slice(&payload[..len as usize]);
    out
}

/// Reads exactly `buf.len()` bytes, or as many as arrive before EOF. Returns how many.
///
/// `read_exact` cannot distinguish "closed cleanly at a frame boundary" from "closed half way
/// through a header", and those are a normal disconnect and a protocol fault respectively.
async fn fill<R>(reader: &mut R, buf: &mut [u8]) -> io::Result<usize>
where
    R: AsyncRead + Unpin + ?Sized,
{
    let mut filled = 0;
    while filled < buf.len() {
        let read = reader.read(&mut buf[filled..]).await?;
        if read == 0 {
            break;
        }
        filled += read;
    }
    Ok(filled)
}

/// Reads one frame.
///
/// Rejects an oversized declared length before allocating; see the module docs.
pub async fn read_packet<R>(reader: &mut R) -> Result<Packet, CodecError>
where
    R: AsyncRead + Unpin + ?Sized,
{
    let mut header = [0u8; HEADER_LEN];
    match fill(reader, &mut header).await? {
        0 => return Err(CodecError::Eof),
        n if n < HEADER_LEN => return Err(CodecError::Truncated),
        _ => {}
    }

    let opcode = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
    let length = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);

    // Before any allocation, and before any further read: an over-long frame is answered by
    // tearing the connection down, so there is no reason to have consumed its body.
    if length > MAX_FRAME_LEN {
        return Err(CodecError::TooLarge(length));
    }

    if length == 0 {
        return Ok(Packet {
            opcode,
            payload: Vec::new(),
        });
    }

    let mut payload = vec![0u8; length as usize];
    if fill(reader, &mut payload).await? < payload.len() {
        return Err(CodecError::Truncated);
    }

    Ok(Packet { opcode, payload })
}

/// Writes one frame and flushes it. Unflushed frames are the other half of the "reimplementation
/// appears to work and doesn't" failure -a buffered `SET_ACTIVITY` reply is the same as no reply.
pub async fn write_packet<W>(writer: &mut W, opcode: u32, payload: &[u8]) -> io::Result<()>
where
    W: AsyncWrite + Unpin + ?Sized,
{
    writer.write_all(&encode(opcode, payload)).await?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opcodes_map_both_ways() {
        for (value, opcode) in [
            (0u32, Opcode::Handshake),
            (1, Opcode::Frame),
            (2, Opcode::Close),
            (3, Opcode::Ping),
            (4, Opcode::Pong),
        ] {
            assert_eq!(Opcode::from_u32(value), Some(opcode));
            assert_eq!(opcode.as_u32(), value);
        }
        assert_eq!(Opcode::from_u32(5), None);
        assert_eq!(Opcode::from_u32(u32::MAX), None);
    }

    #[tokio::test]
    async fn round_trips_a_frame() {
        let payload = br#"{"cmd":"SET_ACTIVITY","nonce":"n1"}"#;
        let bytes = encode(Opcode::Frame.as_u32(), payload);

        // Header is little-endian, as the protocol specifies.
        assert_eq!(&bytes[0..4], &1u32.to_le_bytes());
        assert_eq!(&bytes[4..8], &(payload.len() as u32).to_le_bytes());

        let mut source: &[u8] = &bytes;
        let packet = read_packet(&mut source).await.unwrap();
        assert_eq!(packet.opcode, 1);
        assert_eq!(packet.payload, payload);
        assert!(source.is_empty());
    }

    #[tokio::test]
    async fn round_trips_an_empty_payload() {
        // A zero-length PING is legal and must not be read as EOF.
        let bytes = encode(Opcode::Ping.as_u32(), b"");
        assert_eq!(bytes.len(), HEADER_LEN);

        let mut source: &[u8] = &bytes;
        let packet = read_packet(&mut source).await.unwrap();
        assert_eq!(packet.opcode, Opcode::Ping.as_u32());
        assert!(packet.payload.is_empty());
    }

    #[tokio::test]
    async fn round_trips_several_frames_back_to_back() {
        let mut bytes = encode(0, b"{}");
        bytes.extend(encode(1, b"{\"a\":1}"));
        bytes.extend(encode(3, b"ping"));

        let mut source: &[u8] = &bytes;
        assert_eq!(read_packet(&mut source).await.unwrap().payload, b"{}");
        assert_eq!(read_packet(&mut source).await.unwrap().payload, b"{\"a\":1}");
        assert_eq!(read_packet(&mut source).await.unwrap().payload, b"ping");
        assert!(matches!(
            read_packet(&mut source).await,
            Err(CodecError::Eof)
        ));
    }

    #[tokio::test]
    async fn clean_close_on_a_boundary_is_eof_not_an_error() {
        let mut source: &[u8] = &[];
        assert!(matches!(
            read_packet(&mut source).await,
            Err(CodecError::Eof)
        ));
    }

    #[tokio::test]
    async fn truncated_header_is_rejected() {
        let mut source: &[u8] = &[1, 0, 0];
        assert!(matches!(
            read_packet(&mut source).await,
            Err(CodecError::Truncated)
        ));
    }

    #[tokio::test]
    async fn truncated_payload_is_rejected() {
        let mut bytes = encode(1, b"{\"cmd\":\"SET_ACTIVITY\"}");
        bytes.truncate(bytes.len() - 5);

        let mut source: &[u8] = &bytes;
        assert!(matches!(
            read_packet(&mut source).await,
            Err(CodecError::Truncated)
        ));
    }

    #[tokio::test]
    async fn oversized_length_is_rejected_without_reading_or_allocating_the_payload() {
        // A header claiming 4 GiB, followed by a single byte. If the reader allocated first this
        // test would either OOM or take a visible amount of time; if it read first, the trailing
        // byte would be gone.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&1u32.to_le_bytes());
        bytes.extend_from_slice(&u32::MAX.to_le_bytes());
        bytes.push(0x7B);

        let mut source: &[u8] = &bytes;
        match read_packet(&mut source).await {
            Err(CodecError::TooLarge(len)) => assert_eq!(len, u32::MAX),
            other => panic!("expected TooLarge, got {other:?}"),
        }
        // The body was never consumed -proof the rejection happened on the header alone.
        assert_eq!(source, &[0x7Bu8]);
    }

    #[tokio::test]
    async fn a_length_one_over_the_cap_is_rejected_and_the_cap_itself_is_not() {
        let mut over = Vec::new();
        over.extend_from_slice(&1u32.to_le_bytes());
        over.extend_from_slice(&(MAX_FRAME_LEN + 1).to_le_bytes());
        let mut source: &[u8] = &over;
        assert!(matches!(
            read_packet(&mut source).await,
            Err(CodecError::TooLarge(_))
        ));

        let at_cap = encode(1, &vec![b'x'; MAX_FRAME_LEN as usize]);
        let mut source: &[u8] = &at_cap;
        let packet = read_packet(&mut source).await.unwrap();
        assert_eq!(packet.payload.len(), MAX_FRAME_LEN as usize);
    }

    #[tokio::test]
    async fn an_unknown_opcode_still_decodes_as_a_packet() {
        // Deciding what to do about opcode 9 belongs to the state machine, not the codec -and in
        // proxy mode the bytes are relayed whether or not we understand them.
        let bytes = encode(9, b"?");
        let mut source: &[u8] = &bytes;
        let packet = read_packet(&mut source).await.unwrap();
        assert_eq!(packet.opcode, 9);
        assert_eq!(Opcode::from_u32(packet.opcode), None);
    }

    #[tokio::test]
    async fn write_packet_emits_the_same_bytes_encode_does() {
        let mut sink: Vec<u8> = Vec::new();
        write_packet(&mut sink, Opcode::Pong.as_u32(), b"hello")
            .await
            .unwrap();
        assert_eq!(sink, encode(Opcode::Pong.as_u32(), b"hello"));
    }
}
