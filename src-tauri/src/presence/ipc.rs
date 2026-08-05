//! The Discord-compatible RPC IPC server.
//!
//! Every Discord game integration -`discord-rpc`, the Game SDK, `discord-rich-presence`,
//! `pypresence` -talks to the local Discord client over a socket with no authentication, no
//! signature and no attestation. Whoever owns the socket receives the presence. This module owns it.
//!
//! * **Windows:** named pipe `\\.\pipe\discord-ipc-{0..9}`.
//! * **Unix:** `$XDG_RUNTIME_DIR/discord-ipc-{0..9}`, falling back to `$TMPDIR` then `/tmp`.
//!
//! Built on `tokio::net::windows::named_pipe` and `tokio::net::UnixListener`. There is no Win32 FFI
//! here and no third-party IPC crate: tokio's named-pipe API expresses the whole server loop,
//! including the create-connect-recreate dance that keeps the pipe name continuously available.
//!
//! ## Modes
//!
//! Exactly one process can own `discord-ipc-0`, and client libraries scan `0..9` and stop at the
//! *first* socket that accepts. Binding pipe 3 while Discord holds 0 therefore gains nothing.
//!
//! * **Proxy** (default). Bind the first free index. For each inbound game connection, open our own
//!   client connection to the real Discord on another index and relay frames verbatim in both
//!   directions while snooping `SET_ACTIVITY`. Both Discord and Venta see the presence and the user
//!   notices nothing.
//! * **Exclusive.** Just consume. This is not a separate user decision: it is what a proxy
//!   connection *becomes*, per connection, when no downstream answers -see
//!   [`DOWNSTREAM_READY_TIMEOUT`].
//!
//! ## Every byte is hostile
//!
//! Any process running as the user can open this socket. The defences, in the order an attacker
//! meets them:
//!
//! 1. [`super::codec::MAX_FRAME_LEN`] is checked against the declared length **before** allocating.
//! 2. [`Config::max_connections`] caps concurrency; the surplus is refused, not queued.
//! 3. [`HANDSHAKE_TIMEOUT`] stops an idle connection from holding one of those slots.
//! 4. `client_id` must be a decimal snowflake, and no frame is accepted before a valid handshake.
//! 5. Every string is capped and stripped of control characters in [`super::model`].
//! 6. Activity updates are rate-limited to one per 15 s per connection, mirroring Discord's own.
//!
//! A panic in a connection task cannot take down the listener or the app: each connection is its own
//! `tokio::spawn`, and its arbiter slot is released by a `Drop` guard so it is cleaned up during an
//! unwind as well as on a normal return.

use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::{watch, Semaphore};

use super::arbiter::Arbiter;
use super::codec::{self, CodecError, Opcode, Packet};
use super::protocol::{close, Action, Session, ACTIVITY_INTERVAL};

/// How many `discord-ipc-N` endpoints exist. Fixed by the clients, which scan exactly this range.
pub const ENDPOINT_COUNT: usize = 10;

/// How long a connection may stay silent before its handshake is expected.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a proxied connection waits for the downstream Discord to answer the forwarded
/// handshake before giving up on it and serving the connection exclusively.
///
/// Something is listening on a `discord-ipc-N` address is not the same as Discord is listening on
/// it -another compatible server, a stale process, or a socket that accepts and says nothing would
/// all connect fine and then leave the game waiting for a `READY` that never comes. Falling back
/// here is what makes proxy safe to have on by default.
const DOWNSTREAM_READY_TIMEOUT: Duration = Duration::from_secs(3);

static NEXT_CONNECTION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    /// Relay to the real Discord and snoop. The default, and the most Discord-alike behaviour.
    #[default]
    Proxy,
    /// Consume without relaying.
    Exclusive,
}

impl Mode {
    /// Parses the mode as the frontend states it. Anything unrecognised lands on the default rather
    /// than failing the call -a typo in a settings value should not leave the feature off with no
    /// explanation.
    pub fn parse(value: Option<&str>) -> Self {
        match value.map(str::trim).unwrap_or_default().to_ascii_lowercase().as_str() {
            "exclusive" => Self::Exclusive,
            _ => Self::Proxy,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    pub mode: Mode,
    /// Concurrent connections. Beyond this the surplus is closed immediately; a machine legitimately
    /// running sixteen RPC games at once does not exist, and an unbounded accept loop is a free
    /// handle-exhaustion primitive for anything running as the user.
    pub max_connections: usize,
    /// Minimum spacing between accepted activity updates, per connection.
    pub activity_interval: Duration,
    /// Addresses to probe for a downstream Discord, in order. `None` uses the standard
    /// `discord-ipc-{0..9}` set, skipping our own index.
    pub downstream: Option<Vec<String>>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            mode: Mode::default(),
            max_connections: 16,
            activity_interval: ACTIVITY_INTERVAL,
            downstream: None,
        }
    }
}

/// What the settings page needs in order to say something true about the feature.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub mode: Mode,
    /// The address we bound, for diagnostics.
    pub endpoint: Option<String>,
    /// Which `discord-ipc-N` we won.
    ///
    /// **Anything other than 0 means no game will find us this session.** Clients stop at the first
    /// socket that accepts, so a non-zero index says Discord (or something else) got here first.
    pub index: Option<usize>,
    pub connections: usize,
    pub max_connections: usize,
}

impl Status {
    pub fn stopped(mode: Mode, max_connections: usize) -> Self {
        Self {
            running: false,
            mode,
            endpoint: None,
            index: None,
            connections: 0,
            max_connections,
        }
    }
}

/// A running server. Dropping this does **not** stop it; call [`Server::stop`].
pub struct Server {
    endpoint: String,
    index: usize,
    config: Config,
    shutdown: watch::Sender<bool>,
    permits: Arc<Semaphore>,
}

impl Server {
    pub fn status(&self) -> Status {
        Status {
            running: !*self.shutdown.borrow(),
            mode: self.config.mode,
            endpoint: Some(self.endpoint.clone()),
            index: Some(self.index),
            connections: self
                .config
                .max_connections
                .saturating_sub(self.permits.available_permits()),
            max_connections: self.config.max_connections,
        }
    }

    /// Signals the accept loop and every live connection to unwind. Idempotent.
    pub fn stop(&self) {
        let _ = self.shutdown.send(true);
    }
}

/// Binds the first free `discord-ipc-N`, lowest index first, and starts serving.
///
/// Index 0 is the only one worth having (see [`Status::index`]), but a higher one is still bound:
/// it costs nothing, it is what we will inherit if Discord exits, and it gives the settings page
/// something specific to say instead of a bare failure.
pub fn start(config: Config, arbiter: &'static Arbiter) -> io::Result<Server> {
    let mut last: io::Result<Server> = Err(io::Error::new(
        io::ErrorKind::AddrInUse,
        "every discord-ipc endpoint is taken",
    ));
    for index in 0..ENDPOINT_COUNT {
        let endpoint = platform::endpoint(index);
        match start_on(&endpoint, index, config.clone(), arbiter) {
            Ok(server) => return Ok(server),
            Err(e) => last = Err(e),
        }
    }
    last
}

/// Binds one specific address. Split out from [`start`] so the tests can run the real server over a
/// real socket without touching -or depending on -the machine's actual Discord endpoints.
pub fn start_on(
    endpoint: &str,
    index: usize,
    config: Config,
    arbiter: &'static Arbiter,
) -> io::Result<Server> {
    let listener = platform::Listener::bind(endpoint)?;
    let (shutdown, shutdown_rx) = watch::channel(false);
    let permits = Arc::new(Semaphore::new(config.max_connections));

    let server = Server {
        endpoint: endpoint.to_owned(),
        index,
        config: config.clone(),
        shutdown,
        permits: permits.clone(),
    };

    tokio::spawn(accept_loop(
        listener,
        index,
        config,
        arbiter,
        shutdown_rx,
        permits,
    ));

    Ok(server)
}

async fn accept_loop(
    mut listener: platform::Listener,
    index: usize,
    config: Config,
    arbiter: &'static Arbiter,
    mut shutdown: watch::Receiver<bool>,
    permits: Arc<Semaphore>,
) {
    loop {
        let accepted = tokio::select! {
            biased;
            _ = shutdown.changed() => break,
            result = listener.accept() => result,
        };

        let stream = match accepted {
            Ok(stream) => stream,
            // A failed accept is almost always transient (a client that vanished between connect
            // and our pickup). Backing off keeps a persistent failure from becoming a spin.
            Err(_) => {
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };

        let Ok(permit) = permits.clone().try_acquire_owned() else {
            // Over the cap: refuse it plainly rather than queueing, so a client that is being told
            // "no" finds out now instead of blocking behind fifteen others.
            tokio::spawn(async move {
                let mut stream = stream;
                let _ = write_close(&mut stream, close::RATE_LIMITED, "too many connections").await;
            });
            continue;
        };

        let id = NEXT_CONNECTION_ID.fetch_add(1, Ordering::Relaxed);
        let config = config.clone();
        let shutdown = shutdown.clone();
        // Its own task: a panic in here is caught by tokio and confined to this connection, and the
        // guard inside releases the arbiter slot even during the unwind.
        tokio::spawn(async move {
            let _permit = permit;
            let _guard = ConnectionGuard { id, arbiter };
            handle_connection(stream, id, index, config, arbiter, shutdown).await;
        });
    }

    listener.close();
}

/// Releases a connection's arbiter slot however the task ends -return, error, or panic.
///
/// Without this a crashed connection task would leave the game it was reporting pinned in the
/// merged list until the app restarts.
struct ConnectionGuard {
    id: u64,
    arbiter: &'static Arbiter,
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        self.arbiter.set_rpc(self.id, None);
    }
}

async fn handle_connection(
    mut stream: platform::Inbound,
    id: u64,
    index: usize,
    config: Config,
    arbiter: &'static Arbiter,
    shutdown: watch::Receiver<bool>,
) {
    // The handshake, under a timeout: a connection that opens and says nothing is otherwise a free
    // way to hold one of the sixteen slots indefinitely.
    let first = match tokio::time::timeout(HANDSHAKE_TIMEOUT, codec::read_packet(&mut stream)).await
    {
        Ok(Ok(packet)) => packet,
        Ok(Err(_)) => return,
        Err(_) => {
            let _ = write_close(&mut stream, close::NORMAL, "handshake timeout").await;
            return;
        }
    };

    let mut session = Session::new().with_interval(config.activity_interval);
    let actions = session.on_packet(&first, Instant::now());
    if session.is_closed() {
        // Rejected before any downstream connection is opened, so a hostile client cannot make us
        // hammer Discord's pipe by spamming bad handshakes.
        apply(&mut stream, actions, id, arbiter).await;
        return;
    }

    // Proxy: find the real Discord and hand the handshake straight to it. `downstream_ready` is the
    // first frame it answered with -almost always its own READY -which the game must see before
    // anything else.
    let paired = match config.mode {
        Mode::Exclusive => None,
        Mode::Proxy => pair_downstream(&config, index, &first).await,
    };

    match paired {
        Some((downstream, downstream_ready)) => {
            session.set_relaying(true);
            // Our own READY is discarded: the downstream's is the one being relayed, and a client
            // that received both would either error or double its state.
            if codec::write_packet(
                &mut stream,
                downstream_ready.opcode,
                &downstream_ready.payload,
            )
            .await
            .is_err()
            {
                return;
            }
            relay(stream, downstream, session, id, arbiter, shutdown).await;
        }
        None => {
            if !apply(&mut stream, actions, id, arbiter).await {
                return;
            }
            exclusive(stream, session, id, arbiter, shutdown).await;
        }
    }
}

/// Opens a downstream connection, forwards the handshake, and waits for its first frame.
///
/// Returns `None` -meaning "serve this connection exclusively" -if nothing answers. Every failure
/// mode lands here deliberately: a missing Discord, a busy pipe, a socket that accepts and stays
/// silent, or one that closes on us.
async fn pair_downstream(
    config: &Config,
    own_index: usize,
    handshake: &Packet,
) -> Option<(platform::Outbound, Packet)> {
    let addresses: Vec<String> = match &config.downstream {
        Some(explicit) => explicit.clone(),
        None => (0..ENDPOINT_COUNT)
            .filter(|index| *index != own_index)
            .map(platform::endpoint)
            .collect(),
    };

    for address in addresses {
        let Ok(mut downstream) = platform::connect(&address).await else {
            continue;
        };
        if codec::write_packet(&mut downstream, handshake.opcode, &handshake.payload)
            .await
            .is_err()
        {
            continue;
        }
        match tokio::time::timeout(
            DOWNSTREAM_READY_TIMEOUT,
            codec::read_packet(&mut downstream),
        )
        .await
        {
            Ok(Ok(packet)) => return Some((downstream, packet)),
            // Connected but unusable. Try the next address rather than committing to a peer that
            // will never speak.
            _ => continue,
        }
    }

    None
}

/// Serves a connection with no downstream: we are the Discord it found.
async fn exclusive(
    mut stream: platform::Inbound,
    mut session: Session,
    id: u64,
    arbiter: &'static Arbiter,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        let packet = tokio::select! {
            biased;
            _ = shutdown.changed() => break,
            result = codec::read_packet(&mut stream) => match result {
                Ok(packet) => packet,
                // Includes TooLarge: an over-long declared length is answered by tearing the
                // connection down, having read nothing of its body.
                Err(CodecError::TooLarge(_)) => {
                    let _ = write_close(&mut stream, close::UNSUPPORTED, "frame too large").await;
                    break;
                }
                Err(_) => break,
            },
        };

        let actions = session.on_packet(&packet, Instant::now());
        if !apply(&mut stream, actions, id, arbiter).await {
            break;
        }
    }
}

/// Serves a connection with a downstream Discord behind it.
///
/// Two tasks, each owning one direction, because a single task racing both reads in a `select!`
/// would drop a half-read frame every time the other branch won -[`codec::read_packet`] is not
/// cancel-safe. They are joined only by a stop channel, which is cancel-safe and is the one thing
/// either side is allowed to interrupt the other with.
///
/// A protocol violation from the game tears both connections down without a courtesy `CLOSE`: the
/// only frames that get here after a validated handshake are malformed ones, and every client
/// treats a closed pipe as a disconnect already.
async fn relay(
    stream: platform::Inbound,
    downstream: platform::Outbound,
    session: Session,
    id: u64,
    arbiter: &'static Arbiter,
    shutdown: watch::Receiver<bool>,
) {
    let (inbound_read, inbound_write) = tokio::io::split(stream);
    let (downstream_read, downstream_write) = tokio::io::split(downstream);
    let (stop, stop_rx) = watch::channel(false);

    let mut upstream = tokio::spawn(relay_game_to_discord(
        inbound_read,
        downstream_write,
        session,
        id,
        arbiter,
        stop_rx.clone(),
        shutdown.clone(),
    ));
    let mut downstream_task = tokio::spawn(relay_discord_to_game(
        downstream_read,
        inbound_write,
        stop_rx,
        shutdown,
    ));

    // Whichever direction ends first ends the other. Dropping one half of a `split` does not close
    // the stream, so the signal is what unblocks the survivor.
    tokio::select! {
        _ = &mut upstream => {}
        _ = &mut downstream_task => {}
    }
    let _ = stop.send(true);

    // Both are joined before returning, and the join is not optional. The caller's `ConnectionGuard`
    // clears this connection's arbiter slot as soon as we return; a still-running game-to-Discord
    // task could otherwise land one last `SET_ACTIVITY` *after* that and pin a finished game in the
    // merged list until the app restarts. A `JoinHandle` dropped by `select!` is detached, not
    // cancelled, so nothing else here would have waited for it.
    let _ = upstream.await;
    let _ = downstream_task.await;
}

async fn relay_game_to_discord<R, W>(
    mut reader: R,
    mut writer: W,
    mut session: Session,
    id: u64,
    arbiter: &'static Arbiter,
    mut stop: watch::Receiver<bool>,
    mut shutdown: watch::Receiver<bool>,
) where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    loop {
        let packet = tokio::select! {
            biased;
            _ = stop.changed() => break,
            _ = shutdown.changed() => break,
            result = codec::read_packet(&mut reader) => match result {
                Ok(packet) => packet,
                Err(_) => break,
            },
        };

        let actions = session.on_packet(&packet, Instant::now());
        let mut closing = false;
        for action in actions {
            match action {
                Action::Activity(activity) => arbiter.set_rpc(id, activity),
                Action::Close { .. } => closing = true,
                // Unreachable while relaying, which is exactly what `Session::set_relaying`
                // guarantees; ignored rather than asserted so a future command cannot panic here.
                Action::Reply(_) => {}
            }
        }
        if closing {
            break;
        }

        // Forwarded verbatim, after validation rather than before it: Discord gets the bytes the
        // game sent, byte for byte, so anything we do not model still works.
        if writer.write_all(&packet.encode()).await.is_err() {
            break;
        }
        if writer.flush().await.is_err() {
            break;
        }
    }
}

async fn relay_discord_to_game<R, W>(
    mut reader: R,
    mut writer: W,
    mut stop: watch::Receiver<bool>,
    mut shutdown: watch::Receiver<bool>,
) where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    loop {
        let packet = tokio::select! {
            biased;
            _ = stop.changed() => break,
            _ = shutdown.changed() => break,
            result = codec::read_packet(&mut reader) => match result {
                Ok(packet) => packet,
                Err(_) => break,
            },
        };

        if writer.write_all(&packet.encode()).await.is_err() {
            break;
        }
        if writer.flush().await.is_err() {
            break;
        }
    }
}

/// Performs the state machine's actions. Returns whether the connection should continue.
async fn apply<W>(writer: &mut W, actions: Vec<Action>, id: u64, arbiter: &'static Arbiter) -> bool
where
    W: AsyncWrite + Unpin,
{
    for action in actions {
        match action {
            Action::Activity(activity) => arbiter.set_rpc(id, activity),
            Action::Reply(packet) => {
                if codec::write_packet(writer, packet.opcode, &packet.payload)
                    .await
                    .is_err()
                {
                    return false;
                }
            }
            Action::Close { code, message } => {
                let _ = write_close(writer, code, &message).await;
                return false;
            }
        }
    }
    true
}

async fn write_close<W>(writer: &mut W, code: u32, message: &str) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let payload = serde_json::json!({ "code": code, "message": message });
    let bytes = serde_json::to_vec(&payload).unwrap_or_else(|_| b"{}".to_vec());
    codec::write_packet(writer, Opcode::Close.as_u32(), &bytes).await
}

// ── Platform transport ──────────────────────────────────────────────────────

#[cfg(windows)]
pub mod platform {
    use std::io;
    use std::time::Duration;

    use tokio::net::windows::named_pipe::{
        ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions,
    };

    /// `ERROR_PIPE_BUSY`: the pipe exists but every instance is in use. The documented answer is to
    /// wait and retry, not to conclude that nothing is there.
    const ERROR_PIPE_BUSY: i32 = 231;

    pub type Inbound = NamedPipeServer;
    pub type Outbound = NamedPipeClient;

    pub fn endpoint(index: usize) -> String {
        format!(r"\\.\pipe\discord-ipc-{index}")
    }

    pub struct Listener {
        address: String,
        /// The instance the next `accept` will hand out.
        ///
        /// A named pipe server is one *instance* at a time: it is created, connected, and then a
        /// fresh instance must exist for the next client. Keeping one pre-created narrows the
        /// window in which the pipe name would not exist -a client probing during that window
        /// would decide we are not there and move on to the next index.
        pending: Option<NamedPipeServer>,
    }

    impl Listener {
        pub fn bind(address: &str) -> io::Result<Self> {
            // `first_pipe_instance` is what makes this a real bind: if Discord (or anything else)
            // already owns the name, creation fails instead of quietly adding an instance to
            // somebody else's pipe.
            let pending = ServerOptions::new()
                .first_pipe_instance(true)
                .create(address)?;
            Ok(Self {
                address: address.to_owned(),
                pending: Some(pending),
            })
        }

        pub async fn accept(&mut self) -> io::Result<NamedPipeServer> {
            let server = match self.pending.take() {
                Some(server) => server,
                None => ServerOptions::new().create(&self.address)?,
            };
            server.connect().await?;
            self.pending = ServerOptions::new().create(&self.address).ok();
            Ok(server)
        }

        pub fn close(self) {
            // Named pipes are kernel objects; they disappear with their last handle.
        }
    }

    pub async fn connect(address: &str) -> io::Result<NamedPipeClient> {
        for _ in 0..3 {
            match ClientOptions::new().open(address) {
                Ok(client) => return Ok(client),
                Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                Err(e) => return Err(e),
            }
        }
        Err(io::Error::new(io::ErrorKind::WouldBlock, "pipe busy"))
    }
}

#[cfg(unix)]
pub mod platform {
    use std::io;
    use std::path::PathBuf;

    use tokio::net::{UnixListener, UnixStream};

    pub type Inbound = UnixStream;
    pub type Outbound = UnixStream;

    /// `$XDG_RUNTIME_DIR`, then `$TMPDIR`/`$TMP`/`$TEMP`, then `/tmp` -the order every client
    /// library searches in.
    fn socket_dir() -> PathBuf {
        for key in ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"] {
            if let Ok(value) = std::env::var(key) {
                if !value.is_empty() {
                    return PathBuf::from(value);
                }
            }
        }
        PathBuf::from("/tmp")
    }

    pub fn endpoint(index: usize) -> String {
        socket_dir()
            .join(format!("discord-ipc-{index}"))
            .to_string_lossy()
            .into_owned()
    }

    pub struct Listener {
        listener: UnixListener,
        path: PathBuf,
    }

    impl Listener {
        pub fn bind(address: &str) -> io::Result<Self> {
            let path = PathBuf::from(address);
            // A socket file outlives the process that made it, so a crash leaves an address that
            // binds nothing and blocks everything. Probe it: something answering means the address
            // really is taken; a refused connection means the file is a corpse.
            if path.exists() {
                if std::os::unix::net::UnixStream::connect(&path).is_ok() {
                    return Err(io::Error::new(
                        io::ErrorKind::AddrInUse,
                        "endpoint already in use",
                    ));
                }
                let _ = std::fs::remove_file(&path);
            }
            let listener = UnixListener::bind(&path)?;
            Ok(Self { listener, path })
        }

        pub async fn accept(&mut self) -> io::Result<UnixStream> {
            self.listener.accept().await.map(|(stream, _)| stream)
        }

        pub fn close(self) {
            // Unlinked explicitly so the next run does not have to decide whether it is stale.
            let _ = std::fs::remove_file(&self.path);
        }
    }

    pub async fn connect(address: &str) -> io::Result<UnixStream> {
        UnixStream::connect(address).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::presence::arbiter::Sink;
    use crate::presence::model::{Activity, ActivitySource};
    use serde_json::{json, Value};
    use std::sync::atomic::AtomicUsize;
    use std::sync::Mutex as StdMutex;

    #[derive(Default)]
    struct Recorder(StdMutex<Vec<Vec<Activity>>>);

    impl Recorder {
        fn last(&self) -> Vec<Activity> {
            self.0.lock().unwrap().last().cloned().unwrap_or_default()
        }
    }

    impl Sink for &'static Recorder {
        fn emit(&self, activities: &[Activity]) {
            self.0.lock().unwrap().push(activities.to_vec());
        }
    }

    /// The arbiter is reached as `&'static` from every connection task, so tests leak one too
    /// rather than inventing a second ownership model for them.
    fn leaked_arbiter() -> (&'static Arbiter, &'static Recorder) {
        let recorder: &'static Recorder = Box::leak(Box::new(Recorder::default()));
        let arbiter: &'static Arbiter = Box::leak(Box::new(Arbiter::new(recorder)));
        (arbiter, recorder)
    }

    static TEST_ENDPOINT: AtomicUsize = AtomicUsize::new(0);

    /// A unique address that is deliberately *not* `discord-ipc-N`, so running the suite never
    /// competes with a real Discord (or a real Venta) on the developer's machine.
    fn test_endpoint() -> String {
        let n = TEST_ENDPOINT.fetch_add(1, Ordering::Relaxed);
        let pid = std::process::id();
        #[cfg(windows)]
        {
            format!(r"\\.\pipe\venta-presence-test-{pid}-{n}")
        }
        #[cfg(unix)]
        {
            std::env::temp_dir()
                .join(format!("venta-presence-test-{pid}-{n}"))
                .to_string_lossy()
                .into_owned()
        }
    }

    fn config(mode: Mode) -> Config {
        Config {
            mode,
            // Deliberately tiny so the cap is reachable in a test rather than only in theory.
            max_connections: 2,
            activity_interval: Duration::from_millis(0),
            downstream: None,
        }
    }

    async fn read_frame(stream: &mut platform::Outbound) -> Value {
        let packet = tokio::time::timeout(Duration::from_secs(5), codec::read_packet(stream))
            .await
            .expect("timed out waiting for a frame")
            .expect("frame");
        serde_json::from_slice(&packet.payload).unwrap_or(Value::Null)
    }

    async fn send(stream: &mut platform::Outbound, opcode: Opcode, body: &Value) {
        codec::write_packet(stream, opcode.as_u32(), &serde_json::to_vec(body).unwrap())
            .await
            .unwrap();
    }

    async fn handshake(stream: &mut platform::Outbound) -> Value {
        send(
            stream,
            Opcode::Handshake,
            &json!({"v": 1, "client_id": "356875221078245376"}),
        )
        .await;
        read_frame(stream).await
    }

    // ── End to end, over a real socket ──────────────────────────────────────

    #[tokio::test]
    async fn a_game_can_set_and_clear_its_activity_over_a_real_socket() {
        let (arbiter, recorder) = leaked_arbiter();
        let endpoint = test_endpoint();
        let server = start_on(&endpoint, 0, config(Mode::Exclusive), arbiter).unwrap();

        let mut client = platform::connect(&endpoint).await.unwrap();

        // The READY dispatch, without which `discord-rpc` sends nothing at all.
        let ready = handshake(&mut client).await;
        assert_eq!(ready["cmd"], "DISPATCH");
        assert_eq!(ready["evt"], "READY");

        send(
            &mut client,
            Opcode::Frame,
            &json!({
                "cmd": "SET_ACTIVITY",
                "nonce": "e2e-1",
                "args": {"pid": 4242, "activity": {
                    "details": "Competitive",
                    "state": "In Queue (4 of 5)",
                    "timestamps": {"start": 1_754_300_000},
                    "party": {"id": "p", "size": [4, 5]}
                }}
            }),
        )
        .await;

        // The response frame, with the same nonce. A reimplementation that skips this looks like it
        // works and then puts the game into a reconnect loop.
        let response = read_frame(&mut client).await;
        assert_eq!(response["cmd"], "SET_ACTIVITY");
        assert_eq!(response["nonce"], "e2e-1");
        assert_eq!(response["evt"], Value::Null);

        let merged = recorder.last();
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].source, ActivitySource::Rpc);
        assert_eq!(merged[0].details.as_deref(), Some("Competitive"));
        assert_eq!(merged[0].state.as_deref(), Some("In Queue (4 of 5)"));
        assert_eq!(
            merged[0].application_id.as_deref(),
            Some("356875221078245376")
        );
        assert_eq!(merged[0].started_at, Some(1_754_300_000_000));
        assert!(merged[0].assets.is_none(), "artwork is deferred by decision");

        // PING/PONG carries the payload through unchanged.
        codec::write_packet(&mut client, Opcode::Ping.as_u32(), b"beat")
            .await
            .unwrap();
        let pong = tokio::time::timeout(Duration::from_secs(5), codec::read_packet(&mut client))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(pong.opcode, Opcode::Pong.as_u32());
        assert_eq!(pong.payload, b"beat");

        // `activity: null` clears.
        send(
            &mut client,
            Opcode::Frame,
            &json!({"cmd": "SET_ACTIVITY", "nonce": "e2e-2", "args": {"activity": null}}),
        )
        .await;
        assert_eq!(read_frame(&mut client).await["nonce"], "e2e-2");
        assert!(recorder.last().is_empty());

        server.stop();
    }

    #[tokio::test]
    async fn a_dropped_connection_releases_its_activity_and_leaves_the_listener_running() {
        let (arbiter, recorder) = leaked_arbiter();
        let endpoint = test_endpoint();
        let server = start_on(&endpoint, 0, config(Mode::Exclusive), arbiter).unwrap();

        let mut client = platform::connect(&endpoint).await.unwrap();
        handshake(&mut client).await;
        send(
            &mut client,
            Opcode::Frame,
            &json!({"cmd": "SET_ACTIVITY", "nonce": "n", "args": {"activity": {"details": "d"}}}),
        )
        .await;
        read_frame(&mut client).await;
        assert_eq!(recorder.last().len(), 1);

        drop(client);
        wait_for(|| recorder.last().is_empty()).await;

        // And the listener survived it -a second game connects fine.
        let mut second = platform::connect(&endpoint).await.unwrap();
        assert_eq!(handshake(&mut second).await["evt"], "READY");

        server.stop();
    }

    #[tokio::test]
    async fn a_malformed_client_cannot_take_the_listener_down_with_it() {
        let (arbiter, _recorder) = leaked_arbiter();
        let endpoint = test_endpoint();
        let server = start_on(&endpoint, 0, config(Mode::Exclusive), arbiter).unwrap();

        // Garbage where a handshake should be.
        let mut hostile = platform::connect(&endpoint).await.unwrap();
        hostile.write_all(b"\x00\x00\x00\x00\x05\x00\x00\x00hello").await.unwrap();
        let _ = read_frame(&mut hostile).await;
        drop(hostile);

        // A frame claiming 4 GiB.
        let mut greedy = platform::connect(&endpoint).await.unwrap();
        send(&mut greedy, Opcode::Handshake, &json!({"v": 1, "client_id": "1"})).await;
        read_frame(&mut greedy).await;
        let mut header = Vec::new();
        header.extend_from_slice(&Opcode::Frame.as_u32().to_le_bytes());
        header.extend_from_slice(&u32::MAX.to_le_bytes());
        greedy.write_all(&header).await.unwrap();
        let _ = read_frame(&mut greedy).await;
        drop(greedy);

        let mut healthy = platform::connect(&endpoint).await.unwrap();
        assert_eq!(handshake(&mut healthy).await["evt"], "READY");

        server.stop();
    }

    #[tokio::test]
    async fn a_bad_handshake_is_closed_over_the_wire() {
        let (arbiter, _recorder) = leaked_arbiter();
        let endpoint = test_endpoint();
        let server = start_on(&endpoint, 0, config(Mode::Exclusive), arbiter).unwrap();

        let mut client = platform::connect(&endpoint).await.unwrap();
        send(
            &mut client,
            Opcode::Handshake,
            &json!({"v": 1, "client_id": "not-a-snowflake"}),
        )
        .await;

        let packet = tokio::time::timeout(Duration::from_secs(5), codec::read_packet(&mut client))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(packet.opcode, Opcode::Close.as_u32());
        let body: Value = serde_json::from_slice(&packet.payload).unwrap();
        assert_eq!(body["code"], close::INVALID_CLIENT_ID);

        server.stop();
    }

    #[tokio::test]
    async fn the_connection_cap_refuses_the_surplus() {
        let (arbiter, _recorder) = leaked_arbiter();
        let endpoint = test_endpoint();
        // `max_connections: 2`, from `config`.
        let server = start_on(&endpoint, 0, config(Mode::Exclusive), arbiter).unwrap();

        let mut first = platform::connect(&endpoint).await.unwrap();
        handshake(&mut first).await;
        let mut second = platform::connect(&endpoint).await.unwrap();
        handshake(&mut second).await;

        let mut third = platform::connect(&endpoint).await.unwrap();
        let packet = tokio::time::timeout(Duration::from_secs(5), codec::read_packet(&mut third))
            .await
            .expect("the surplus connection should be refused, not left hanging")
            .unwrap();
        assert_eq!(packet.opcode, Opcode::Close.as_u32());
        let body: Value = serde_json::from_slice(&packet.payload).unwrap();
        assert_eq!(body["code"], close::RATE_LIMITED);

        assert_eq!(server.status().connections, 2);
        assert_eq!(server.status().max_connections, 2);

        server.stop();
    }

    #[tokio::test]
    async fn rate_limiting_holds_over_a_real_socket() {
        let (arbiter, recorder) = leaked_arbiter();
        let endpoint = test_endpoint();
        let mut config = config(Mode::Exclusive);
        config.activity_interval = Duration::from_secs(3600);
        let server = start_on(&endpoint, 0, config, arbiter).unwrap();

        let mut client = platform::connect(&endpoint).await.unwrap();
        handshake(&mut client).await;

        for (nonce, details) in [("a", "first"), ("b", "second"), ("c", "third")] {
            send(
                &mut client,
                Opcode::Frame,
                &json!({"cmd": "SET_ACTIVITY", "nonce": nonce, "args": {"activity": {"details": details}}}),
            )
            .await;
            // Every request is answered, throttled or not.
            assert_eq!(read_frame(&mut client).await["nonce"], nonce);
        }

        // Only the first got through to the arbiter.
        let merged = recorder.last();
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].details.as_deref(), Some("first"));

        server.stop();
    }

    // ── Proxy ───────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn proxy_relays_to_a_downstream_and_snoops_on_the_way_past() {
        // The "real Discord": a second instance of this very server, which is the only downstream
        // that can be stood up hermetically -and it speaks exactly the protocol we claim to.
        let (downstream_arbiter, downstream_recorder) = leaked_arbiter();
        let downstream_endpoint = test_endpoint();
        let downstream =
            start_on(&downstream_endpoint, 1, config(Mode::Exclusive), downstream_arbiter).unwrap();

        let (arbiter, recorder) = leaked_arbiter();
        let endpoint = test_endpoint();
        let mut proxy_config = config(Mode::Proxy);
        proxy_config.downstream = Some(vec![downstream_endpoint.clone()]);
        let server = start_on(&endpoint, 0, proxy_config, arbiter).unwrap();

        let mut client = platform::connect(&endpoint).await.unwrap();

        // The READY the game receives came from downstream, relayed -we send none of our own.
        let ready = handshake(&mut client).await;
        assert_eq!(ready["evt"], "READY");

        send(
            &mut client,
            Opcode::Frame,
            &json!({
                "cmd": "SET_ACTIVITY",
                "nonce": "proxy-1",
                "args": {"activity": {"details": "Relayed"}}
            }),
        )
        .await;

        // Exactly one response, with the right nonce -not two.
        let response = read_frame(&mut client).await;
        assert_eq!(response["cmd"], "SET_ACTIVITY");
        assert_eq!(response["nonce"], "proxy-1");

        // Both sides saw the activity: that is the whole point of proxy mode.
        wait_for(|| recorder.last().len() == 1).await;
        wait_for(|| downstream_recorder.last().len() == 1).await;
        assert_eq!(recorder.last()[0].details.as_deref(), Some("Relayed"));
        assert_eq!(
            downstream_recorder.last()[0].details.as_deref(),
            Some("Relayed")
        );

        server.stop();
        downstream.stop();
    }

    #[tokio::test]
    async fn a_downstream_that_dies_releases_the_relayed_activity() {
        let (downstream_arbiter, _) = leaked_arbiter();
        let downstream_endpoint = test_endpoint();
        let downstream =
            start_on(&downstream_endpoint, 1, config(Mode::Exclusive), downstream_arbiter).unwrap();

        let (arbiter, recorder) = leaked_arbiter();
        let endpoint = test_endpoint();
        let mut proxy_config = config(Mode::Proxy);
        proxy_config.downstream = Some(vec![downstream_endpoint]);
        let server = start_on(&endpoint, 0, proxy_config, arbiter).unwrap();

        let mut client = platform::connect(&endpoint).await.unwrap();
        handshake(&mut client).await;
        send(
            &mut client,
            Opcode::Frame,
            &json!({"cmd": "SET_ACTIVITY", "nonce": "n", "args": {"activity": {"details": "d"}}}),
        )
        .await;
        wait_for(|| recorder.last().len() == 1).await;

        // Discord goes away underneath us. The relay must unwind *both* directions and release the
        // slot -a game left pinned in the merged list would stay there until the app restarts.
        downstream.stop();
        wait_for(|| recorder.last().is_empty()).await;

        server.stop();
    }

    #[tokio::test]
    async fn proxy_falls_back_to_exclusive_when_no_downstream_answers() {
        let (arbiter, recorder) = leaked_arbiter();
        let endpoint = test_endpoint();
        let mut proxy_config = config(Mode::Proxy);
        // An address nothing is listening on.
        proxy_config.downstream = Some(vec![test_endpoint()]);
        let server = start_on(&endpoint, 0, proxy_config, arbiter).unwrap();

        let mut client = platform::connect(&endpoint).await.unwrap();
        // Our own READY, because there was nobody to relay one from. Automatic, not a second user
        // decision.
        let ready = handshake(&mut client).await;
        assert_eq!(ready["evt"], "READY");
        assert_eq!(ready["data"]["user"]["username"], "venta");

        send(
            &mut client,
            Opcode::Frame,
            &json!({"cmd": "SET_ACTIVITY", "nonce": "x", "args": {"activity": {"details": "Solo"}}}),
        )
        .await;
        assert_eq!(read_frame(&mut client).await["nonce"], "x");
        assert_eq!(recorder.last()[0].details.as_deref(), Some("Solo"));

        server.stop();
    }

    // ── Binding ─────────────────────────────────────────────────────────────

    #[tokio::test]
    async fn an_address_that_is_already_bound_is_refused() {
        let (arbiter, _recorder) = leaked_arbiter();
        let endpoint = test_endpoint();
        let first = start_on(&endpoint, 0, config(Mode::Exclusive), arbiter).unwrap();

        // This is the mechanism `start` relies on to walk 0..9: a taken address must fail to bind
        // rather than quietly sharing with whoever holds it.
        assert!(start_on(&endpoint, 0, config(Mode::Exclusive), arbiter).is_err());

        first.stop();
    }

    #[test]
    fn endpoints_are_the_addresses_the_clients_look_for() {
        for index in 0..ENDPOINT_COUNT {
            let endpoint = platform::endpoint(index);
            assert!(
                endpoint.ends_with(&format!("discord-ipc-{index}")),
                "unexpected endpoint {endpoint}"
            );
        }
        #[cfg(windows)]
        assert!(platform::endpoint(0).starts_with(r"\\.\pipe\"));
    }

    #[test]
    fn mode_parses_leniently_and_defaults_to_proxy() {
        assert_eq!(Mode::parse(Some("proxy")), Mode::Proxy);
        assert_eq!(Mode::parse(Some(" Exclusive ")), Mode::Exclusive);
        assert_eq!(Mode::parse(Some("EXCLUSIVE")), Mode::Exclusive);
        assert_eq!(Mode::parse(Some("nonsense")), Mode::Proxy);
        assert_eq!(Mode::parse(None), Mode::Proxy);
        assert_eq!(Mode::default(), Mode::Proxy);
    }

    #[test]
    fn the_mode_serializes_as_the_frontend_states_it() {
        assert_eq!(serde_json::to_string(&Mode::Proxy).unwrap(), "\"proxy\"");
        assert_eq!(
            serde_json::to_string(&Mode::Exclusive).unwrap(),
            "\"exclusive\""
        );
    }

    /// Polls a condition rather than sleeping a fixed amount: the relay hands off between two tasks,
    /// and any constant long enough to be reliable would also be long enough to be slow.
    async fn wait_for(mut condition: impl FnMut() -> bool) {
        for _ in 0..200 {
            if condition() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        panic!("condition never became true");
    }
}
