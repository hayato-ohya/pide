//! Minimal Jupyter kernel client: launches `ipykernel`, speaks the wire
//! protocol over ZeroMQ (pure Rust `zeromq` crate) and broadcasts every
//! message it receives.  UI independent.

pub mod message;
pub mod launch;
pub mod platform;

use std::collections::{HashMap, VecDeque};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use anyhow::{Context, Result};
use bytes::Bytes;
use serde_json::{json, Value};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, mpsc, Mutex};
use futures_util::StreamExt;
pub use tokio_util::sync::CancellationToken;
use zeromq::util::PeerIdentity;
use zeromq::{DealerSendHalf, DealerSocket, ReqSocket, Socket, SocketEvent, SocketOptions, SocketRecv, SocketSend, SubSocket, ZmqError, ZmqMessage};

pub use launch::{ConnectionInfo, LaunchSpec};
pub use message::{Header, Message, Signer};

/// Which socket a message arrived on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Shell,
    IoPub,
    Control,
    Stdin,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Event {
    pub channel: Channel,
    pub msg: Message,
}

/// Why `Kernel::liveness` considers the kernel gone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Liveness {
    Alive,
    /// The kernel process (or, remote, its SSH session / tunnel) exited, or it was shut down.
    Exited,
    /// A channel dropped and could not be reconnected.
    Link,
    /// The heartbeat stopped answering; it may come back.
    Heartbeat,
}

impl Liveness {
    pub fn as_str(self) -> &'static str {
        match self {
            Liveness::Alive => "alive",
            Liveness::Exited => "exited",
            Liveness::Link => "link",
            Liveness::Heartbeat => "heartbeat",
        }
    }
}

/// Returned (inside `anyhow::Error`) when a launch was aborted through its cancellation token.
#[derive(Debug)]
pub struct Cancelled;

impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("kernel start cancelled")
    }
}

impl std::error::Error for Cancelled {}

/// Run a launch step until it finishes or `cancel` fires.  Dropping the step kills what it
/// spawned so far (kill_on_drop children, `GroupGuard`).
async fn cancellable<T>(cancel: &CancellationToken, f: impl std::future::Future<Output = Result<T>>) -> Result<T> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(Cancelled.into()),
        r = f => r,
    }
}

/// Kills a starting local kernel's process group unless disarmed (kill_on_drop only reaches the
/// leader, e.g. a wrapper script, not what it already started).
struct GroupGuard(Option<u32>);

impl Drop for GroupGuard {
    fn drop(&mut self) {
        if let Some(pid) = self.0 {
            platform::kill_group(pid);
        }
    }
}

pub struct Kernel {
    child: Mutex<Option<Child>>,
    /// Helper processes (SSH tunnels) that must die with the kernel.
    extra: Mutex<Vec<Child>>,
    /// True when the kernel process is not local (interrupt via control channel).
    pub remote: bool,
    /// False for kernels we merely attached to: never send them shutdown_request.
    pub owned: bool,
    pub info: ConnectionInfo,
    signer: Signer,
    session: String,
    shell_tx: mpsc::Sender<ZmqMessage>,
    control_tx: mpsc::Sender<ZmqMessage>,
    stdin_tx: mpsc::Sender<ZmqMessage>,
    events: broadcast::Sender<Event>,
    /// Cancels every task spawned for this kernel (socket pumps, heartbeat).
    cancel: CancellationToken,
    /// Set by the heartbeat task after repeated misses, cleared when it answers again.
    hb_dead: Arc<AtomicBool>,
    /// Set when a channel dropped and could not be reconnected (see `dealer`): the
    /// kernel must be restarted.
    link_dead: Arc<AtomicBool>,
    /// Bumped each time a channel was reconnected (replies in flight may have been lost).
    reconnects: Arc<AtomicU64>,
    _conn_file: Option<launch::ConnFile>,
    /// Interrupt / parent handles for a locally launched kernel.
    handles: platform::KernelHandles,
}

impl Drop for Kernel {
    fn drop(&mut self) {
        self.cancel.cancel();
        // kill_on_drop only reaches the kernel itself; take its process group with it.
        if !self.remote {
            if let Some(pid) = self.child.get_mut().as_ref().and_then(|c| c.id()) {
                platform::kill_group(pid);
            }
        }
    }
}

impl Kernel {
    /// Launch a kernel process and connect all channels.
    pub async fn launch(spec: LaunchSpec) -> Result<Arc<Kernel>> {
        Self::launch_cancellable(spec, &CancellationToken::new()).await
    }

    /// `launch`, aborted (killing the kernel's process group) when `cancel` fires.
    pub async fn launch_cancellable(spec: LaunchSpec, cancel: &CancellationToken) -> Result<Arc<Kernel>> {
        cancellable(cancel, Self::launch_inner(spec)).await
    }

    async fn launch_inner(spec: LaunchSpec) -> Result<Arc<Kernel>> {
        let info = ConnectionInfo::new_local()?;
        let conn_file = launch::ConnFile::write(&info)?;

        let mut cmd = Command::new(&spec.python);
        cmd.args(["-m", "ipykernel_launcher", "-f"])
            .arg(conn_file.path())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        platform::quiet(&mut cmd);
        platform::own_process_group(&mut cmd);
        if let Some(cwd) = &spec.cwd {
            cmd.current_dir(cwd);
        }
        // Never let a user's PYTHONPATH/cwd shadow stdlib modules the kernel imports.
        cmd.env("PYTHONSAFEPATH", "1");
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        let handles = platform::KernelHandles::prepare(&mut cmd);
        let mut child = cmd.spawn().context("spawning ipykernel")?;
        let mut group = GroupGuard(child.id());
        // Forward kernel stderr/stdout to tracing so they are never lost.
        if let Some(out) = child.stdout.take() {
            tokio::spawn(pipe_log("kernel.stdout", out, None));
        }
        let tail = match child.stderr.take() {
            Some(err) => StderrTail::spawn("kernel.stderr", err),
            None => StderrTail::default(),
        };
        let k = Self::connect_inner(info, Some((child, tail)), vec![], false, true, Some(conn_file), handles).await?;
        group.0 = None; // the Kernel's Drop / shutdown takes over
        Ok(k)
    }

    /// Connect to an already running kernel described by a connection file
    /// (e.g. a kernel started by hand, or in a container with published ports).
    pub async fn connect(info: ConnectionInfo) -> Result<Arc<Kernel>> {
        Self::connect_cancellable(info, &CancellationToken::new()).await
    }

    pub async fn connect_cancellable(info: ConnectionInfo, cancel: &CancellationToken) -> Result<Arc<Kernel>> {
        cancellable(cancel, Self::connect_inner(info, None, vec![], true, false, None, Default::default())).await
    }

    /// Start a kernel on a remote host over SSH and tunnel its ports.
    ///
    /// 1. upload the `pide_kernel` helper (single file) to `~/.pide`
    /// 2. run a bootstrap that picks free ports, starts ipykernel, prints the
    ///    connection info once it listens and supervises it (that SSH session,
    ///    with its stdin held open by us, stays open for the kernel's lifetime)
    /// 3. open a second SSH session with `-L` forwards for the five ports
    pub async fn launch_remote(spec: launch::RemoteSpec, helper_src: &str) -> Result<Arc<Kernel>> {
        Self::launch_remote_cancellable(spec, helper_src, &CancellationToken::new()).await
    }

    /// `launch_remote`, aborted (killing the SSH sessions started so far) when `cancel` fires.
    pub async fn launch_remote_cancellable(spec: launch::RemoteSpec, helper_src: &str, cancel: &CancellationToken) -> Result<Arc<Kernel>> {
        cancellable(cancel, Self::launch_remote_inner(spec, helper_src)).await
    }

    async fn launch_remote_inner(spec: launch::RemoteSpec, helper_src: &str) -> Result<Arc<Kernel>> {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
        if spec.host.starts_with('-') || spec.host.is_empty() {
            anyhow::bail!("invalid ssh host {:?}", spec.host);
        }
        let ssh = spec.ssh.clone().unwrap_or_else(|| "ssh".into());
        let base_args = |s: &launch::RemoteSpec| -> Vec<String> {
            let mut a = vec![
                "-o".into(), "BatchMode=yes".into(),
                "-o".into(), "ServerAliveInterval=15".into(),
                "-o".into(), "ServerAliveCountMax=3".into(),
                "-o".into(), "ConnectTimeout=15".into(),
            ];
            if let Some(p) = s.port { a.push("-p".into()); a.push(p.to_string()); }
            a.extend(s.ssh_args.clone());
            a
        };

        // 1. helper upload
        let mut up = Command::new(&ssh);
        up.args(base_args(&spec)).arg("--").arg(&spec.host)
            .arg("umask 077 && mkdir -p ~/.pide/pide_kernel && chmod 700 ~/.pide && cat > ~/.pide/pide_kernel/__init__.py")
            .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true);
        let mut up_child = platform::quiet(&mut up).spawn().context("ssh (upload helper)")?;
        if let Some(mut stdin) = up_child.stdin.take() {
            // A write error (EPIPE when ssh fails to connect) is reported below via ssh's own
            // exit status and stderr, which say what actually went wrong.
            let _ = stdin.write_all(helper_src.as_bytes()).await;
            drop(stdin);
        }
        let st = up_child.wait_with_output().await?;
        if !st.status.success() {
            anyhow::bail!("ssh upload failed ({}): {}", st.status, String::from_utf8_lossy(&st.stderr).trim());
        }

        // 2. remote bootstrap: free ports → connection file → ipykernel as its child.  The
        // bootstrap stays alive as the kernel's parent: it prints PIDE_CONN only once the
        // kernel listens, and stops the kernel and removes the connection file when its
        // stdin (our ssh session) reaches EOF — also when the app crashes, since OpenSSH
        // does not end the remote command on its own.
        let cwd = spec.cwd.clone().unwrap_or_else(|| "~".into());
        let b64 = b64encode(REMOTE_BOOTSTRAP.as_bytes());
        // cwd is handed to Python (expanduser + chdir) so no shell quoting of user paths is needed.
        let cwd_b64 = b64encode(cwd.as_bytes());
        // `exec` replaces the login shell with Python so no intermediate shell survives.  Values
        // travel as argv (base64 is shell-safe) and the code has no `$`, `!` or backquotes, so
        // this parses the same in sh/bash/zsh, csh/tcsh and fish login shells.
        let remote_cmd = format!(
            "exec {} -c \"import base64,os,sys;os.chdir(os.path.expanduser(base64.b64decode(sys.argv[1]).decode()));exec(base64.b64decode(sys.argv[2]))\" {} {}",
            shell_quote(&spec.python), cwd_b64, b64
        );
        let mut run = Command::new(&ssh);
        run.args(base_args(&spec)).arg("--").arg(&spec.host).arg(&remote_cmd)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        let mut kernel_child = platform::quiet(&mut run).spawn().context("ssh (start kernel)")?;
        let stdout = kernel_child.stdout.take().unwrap();
        let tail = match kernel_child.stderr.take() {
            Some(err) => StderrTail::spawn("remote.stderr", err),
            None => StderrTail::default(),
        };
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        let remote_info: Result<ConnectionInfo> = async {
            loop {
                let line = tokio::time::timeout(std::time::Duration::from_secs(60), lines.next_line()).await
                    .context("timeout waiting for remote kernel to start")??
                    .ok_or_else(|| anyhow::anyhow!("remote kernel exited before printing connection info"))?;
                if let Some(json) = line.strip_prefix("PIDE_CONN:") {
                    return serde_json::from_str(json).context("parsing remote connection info");
                }
                tracing::debug!(target: "kernel", "[remote.stdout] {line}");
            }
        }
        .await;
        let remote_info = match remote_info {
            Ok(i) => i,
            Err(e) => return Err(tail.annotate(e).await),
        };
        tokio::spawn(async move {
            while let Ok(Some(l)) = lines.next_line().await {
                tracing::debug!(target: "kernel", "[remote.stdout] {l}");
            }
        });

        // 3. tunnels: local free ports → remote kernel ports
        let local = ConnectionInfo::new_local()?;
        let pairs = [
            (local.shell_port, remote_info.shell_port),
            (local.iopub_port, remote_info.iopub_port),
            (local.stdin_port, remote_info.stdin_port),
            (local.control_port, remote_info.control_port),
            (local.hb_port, remote_info.hb_port),
        ];
        let mut tun = Command::new(&ssh);
        // ExitOnForwardFailure: a port that cannot be forwarded ends ssh instead of leaving a
        // tunnel that silently drops that channel.
        tun.args(base_args(&spec)).args(["-o", "ExitOnForwardFailure=yes"]);
        for (l, r) in pairs {
            tun.arg("-L").arg(format!("127.0.0.1:{l}:127.0.0.1:{r}"));
        }
        // Not `-N`: a remote `cat` that ends on stdin EOF ties the tunnel to the stdin pipe we
        // keep open in `tun_child`, so it also goes away when the app dies (an `ssh -N` would
        // be orphaned and keep running).
        tun.arg("--").arg(&spec.host).arg("cat >/dev/null")
            .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true);
        let mut tun_child = platform::quiet(&mut tun).spawn().context("ssh (tunnel)")?;
        if let Some(err) = tun_child.stderr.take() {
            tokio::spawn(pipe_log("tunnel.stderr", err, None));
        }
        // No fixed sleep: connect_channels retries until the tunnel forwards.

        let info = ConnectionInfo { key: remote_info.key.clone(), signature_scheme: remote_info.signature_scheme.clone(), ..local };
        Self::connect_inner(info, Some((kernel_child, tail)), vec![tun_child], true, true, None, Default::default()).await
    }

    /// Connect, and on failure append what the kernel process wrote to stderr.
    async fn connect_inner(
        info: ConnectionInfo,
        child: Option<(Child, StderrTail)>,
        extra: Vec<Child>,
        remote: bool,
        owned: bool,
        conn_file: Option<launch::ConnFile>,
        handles: platform::KernelHandles,
    ) -> Result<Arc<Kernel>> {
        let (child, tail) = child.unzip();
        match (Self::connect_channels(info, child, extra, remote, owned, conn_file, handles).await, tail) {
            (Err(e), Some(tail)) => Err(tail.annotate(e).await),
            (r, _) => r,
        }
    }

    async fn connect_channels(
        info: ConnectionInfo,
        mut child: Option<Child>,
        mut extra: Vec<Child>,
        remote: bool,
        owned: bool,
        conn_file: Option<launch::ConnFile>,
        handles: platform::KernelHandles,
    ) -> Result<Arc<Kernel>> {
        if info.signature_scheme != "hmac-sha256" && !info.key.is_empty() {
            anyhow::bail!("unsupported signature scheme {:?}", info.signature_scheme);
        }
        let signer = Signer::new(&info.key);
        let session = uuid::Uuid::new_v4().to_string();
        // Large enough that a tight print loop does not drop the execute_reply.
        let (events, _) = broadcast::channel(65_536);
        let cancel = CancellationToken::new();
        // Created before the channels: a DEALER that lost its connection keeps reconnecting
        // while the heartbeat says the kernel is there.
        let hb_dead = Arc::new(AtomicBool::new(false));
        let reconnects = Arc::new(AtomicU64::new(0));

        // A kernel bound to all interfaces is reached over loopback.
        let host = match info.ip.as_str() {
            "0.0.0.0" | "*" => "127.0.0.1",
            ip => ip,
        };
        let ep = |port: u16| format!("tcp://{host}:{port}");

        // Dealer sockets (shell / control / stdin): a supervisor task per channel feeds
        // the socket from an mpsc, pumps what it receives into the broadcast channel and
        // reconnects it when it drops.  zeromq retries a refused connect for up to 30 s,
        // so race it against the kernel dying.
        let attempt = || async {
            // Per attempt, so pumps of a failed attempt can neither linger nor mark the
            // link of the next one dead.
            let cancel = cancel.child_token();
            let link_dead = Arc::new(AtomicBool::new(false));
            let r = async {
                let shared = ChannelShared {
                    signer: signer.clone(),
                    events: events.clone(),
                    cancel: cancel.clone(),
                    link_dead: link_dead.clone(),
                    hb_dead: hb_dead.clone(),
                    reconnects: reconnects.clone(),
                };
                let d = |port: u16, channel: Channel| dealer(ep(port), channel, &session, shared.clone());
                let shell_tx = d(info.shell_port, Channel::Shell).await?;
                let control_tx = d(info.control_port, Channel::Control).await?;
                let stdin_tx = d(info.stdin_port, Channel::Stdin).await?;
                // IOPub subscriber (zeromq's SUB reconnects by itself and re-subscribes).
                let mut sub = SubSocket::new();
                sub.connect(&ep(info.iopub_port)).await.context("connect iopub")?;
                sub.subscribe("").await?;
                anyhow::Ok((shell_tx, control_tx, stdin_tx, sub))
            }
            .await;
            if r.is_err() {
                cancel.cancel();
            }
            r.map(|(a, b, c, d)| (a, b, c, d, link_dead))
        };
        // Through an SSH tunnel (or a proxy such as docker's) the local TCP connect is
        // accepted even while nothing listens behind it; the far side then closes and
        // zeromq reports the handshake EOF as a hard error.  Retry until a deadline.
        let setup = async {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(60);
            let mut delay = std::time::Duration::from_millis(100);
            loop {
                match attempt().await {
                    Ok(v) => return Ok(v),
                    Err(e) if remote && tokio::time::Instant::now() + delay < deadline => {
                        tracing::debug!("kernel connect failed, retrying in {delay:?}: {e:#}");
                        tokio::time::sleep(delay).await;
                        delay = (delay * 2).min(std::time::Duration::from_secs(2));
                    }
                    Err(e) => return Err(e),
                }
            }
        };
        let (shell_tx, control_tx, stdin_tx, mut sub, link_dead) = tokio::select! {
            r = setup => r?,
            e = exited(&mut child, &mut extra) => return Err(e),
        };
        {
            let signer = signer.clone();
            let events = events.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move {
                loop {
                    let m = tokio::select! {
                        _ = cancel.cancelled() => break,
                        r = sub.recv() => r,
                    };
                    match m {
                        Ok(m) => match Message::decode(m.into_vec(), &signer) {
                            Ok(msg) => {
                                let _ = events.send(Event { channel: Channel::IoPub, msg });
                            }
                            Err(e) => tracing::warn!("iopub decode: {e:#}"),
                        },
                        Err(e) => {
                            // The peer dropped: zeromq's reconnect task brings it back (messages
                            // published meanwhile are lost); a later loss shows as a heartbeat
                            // or DEALER failure.
                            tracing::warn!("iopub connection lost: {e}");
                            tokio::select! {
                                _ = cancel.cancelled() => break,
                                _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {}
                            }
                        }
                    }
                }
                drop(sub);
            });
        }

        // Heartbeat: REQ/REP ping every 3 s; three misses mark the kernel dead
        // until it answers again.  Started only once the kernel is ready, so a
        // slow startup is bounded by wait_ready alone.
        let (hb_start, hb_start_rx) = tokio::sync::oneshot::channel::<()>();
        {
            let hb_ep = ep(info.hb_port);
            let cancel = cancel.clone();
            let flag2 = hb_dead.clone();
            tokio::spawn(async move {
                tokio::select! {
                    _ = cancel.cancelled() => return,
                    r = hb_start_rx => if r.is_err() { return },
                }
                let mut misses = 0u32;
                'outer: loop {
                    let mut sock = ReqSocket::new();
                    let connected = tokio::select! {
                        _ = cancel.cancelled() => break,
                        r = tokio::time::timeout(std::time::Duration::from_secs(3), sock.connect(&hb_ep)) => matches!(r, Ok(Ok(_))),
                    };
                    if !connected {
                        misses += 1; // refused / unreachable counts as a missed beat
                        tracing::debug!("heartbeat connect failed ({misses})");
                        if misses >= 3 && !flag2.swap(true, Ordering::Relaxed) {
                            tracing::warn!("kernel heartbeat lost");
                        }
                        tokio::select! { _ = cancel.cancelled() => break, _ = tokio::time::sleep(std::time::Duration::from_secs(3)) => {} }
                        continue;
                    }
                    loop {
                        tokio::select! { _ = cancel.cancelled() => break 'outer, _ = tokio::time::sleep(std::time::Duration::from_secs(3)) => {} }
                        // send() blocks while the peer is gone, so it needs a timeout as well.
                        let sent = tokio::select! {
                            _ = cancel.cancelled() => break 'outer,
                            r = tokio::time::timeout(std::time::Duration::from_secs(3), sock.send(ZmqMessage::from("ping"))) => r,
                        };
                        if !matches!(sent, Ok(Ok(()))) {
                            misses += 1;
                            break;
                        }
                        let got = tokio::select! {
                            _ = cancel.cancelled() => break 'outer,
                            r = tokio::time::timeout(std::time::Duration::from_secs(3), sock.recv()) => r,
                        };
                        match got {
                            Ok(Ok(_)) => {
                                misses = 0;
                                if flag2.swap(false, Ordering::Relaxed) {
                                    tracing::info!("kernel heartbeat recovered");
                                }
                            }
                            _ => { misses += 1; break; } // REQ state is now broken: rebuild the socket
                        }
                    }
                    if misses >= 3 && !flag2.swap(true, Ordering::Relaxed) {
                        tracing::warn!("kernel heartbeat lost");
                    }
                }
            });
        }

        let kernel = Arc::new(Kernel {
            child: Mutex::new(child),
            extra: Mutex::new(extra),
            remote,
            owned,
            info,
            signer,
            session,
            shell_tx,
            control_tx,
            stdin_tx,
            events,
            cancel,
            hb_dead,
            link_dead,
            reconnects,
            _conn_file: conn_file,
            handles,
        });

        // Wait until the kernel answers kernel_info (ipykernel needs ~1s to bind).
        kernel.wait_ready(std::time::Duration::from_secs(60)).await?;
        let _ = hb_start.send(());
        Ok(kernel)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.events.subscribe()
    }

    fn build(&self, msg_type: &str, content: Value) -> (String, ZmqMessage) {
        self.build_with_id(msg_type, content, None)
    }

    /// Like `build`, but the caller may supply the msg_id so it can register
    /// handlers before the request is even sent (avoids reply/ID races).
    fn build_with_id(&self, msg_type: &str, content: Value, msg_id: Option<String>) -> (String, ZmqMessage) {
        let mut header = Header::new(msg_type, &self.session);
        if let Some(id) = msg_id {
            header.msg_id = id;
        }
        let id = header.msg_id.clone();
        let msg = Message {
            header,
            parent_header: json!({}),
            metadata: json!({}),
            content,
            buffers: vec![],
        };
        (id, msg.encode(&self.signer))
    }

    /// Send an execute_request. Returns the msg_id so callers can match replies.
    pub async fn execute(
        &self,
        code: &str,
        silent: bool,
        store_history: bool,
        user_expressions: HashMap<String, String>,
        allow_stdin: bool,
    ) -> Result<String> {
        self.execute_with_id(code, silent, store_history, user_expressions, allow_stdin, None).await
    }

    pub async fn execute_with_id(
        &self,
        code: &str,
        silent: bool,
        store_history: bool,
        user_expressions: HashMap<String, String>,
        allow_stdin: bool,
        msg_id: Option<String>,
    ) -> Result<String> {
        let (id, msg) = self.build_with_id(
            "execute_request",
            json!({
                "code": code,
                "silent": silent,
                "store_history": store_history,
                "user_expressions": user_expressions,
                "allow_stdin": allow_stdin,
                "stop_on_error": true,
            }),
            msg_id,
        );
        self.shell_tx.send(msg).await?;
        Ok(id)
    }

    pub async fn complete(&self, code: &str, cursor_pos: usize) -> Result<String> {
        let (id, msg) = self.build("complete_request", json!({"code": code, "cursor_pos": cursor_pos}));
        self.shell_tx.send(msg).await?;
        Ok(id)
    }

    pub async fn inspect(&self, code: &str, cursor_pos: usize, detail_level: u8) -> Result<String> {
        let (id, msg) = self.build(
            "inspect_request",
            json!({"code": code, "cursor_pos": cursor_pos, "detail_level": detail_level}),
        );
        self.shell_tx.send(msg).await?;
        Ok(id)
    }

    pub async fn is_complete(&self, code: &str) -> Result<String> {
        let (id, msg) = self.build("is_complete_request", json!({"code": code}));
        self.shell_tx.send(msg).await?;
        Ok(id)
    }

    /// Send an arbitrary request on the control channel (e.g. debug_request).
    pub async fn control(&self, msg_type: &str, content: Value) -> Result<String> {
        let (id, msg) = self.build(msg_type, content);
        self.control_tx.send(msg).await?;
        Ok(id)
    }

    pub async fn kernel_info(&self) -> Result<String> {
        let (id, msg) = self.build("kernel_info_request", json!({}));
        self.shell_tx.send(msg).await?;
        Ok(id)
    }

    /// Reply to an input_request from the kernel.
    pub async fn input_reply(&self, parent: &Header, value: &str) -> Result<()> {
        let header = Header::new("input_reply", &self.session);
        let msg = Message {
            header,
            parent_header: serde_json::to_value(parent)?,
            metadata: json!({}),
            content: json!({"value": value}),
            buffers: vec![],
        };
        self.stdin_tx.send(msg.encode(&self.signer)).await?;
        Ok(())
    }

    /// Interrupt the running cell (SIGINT, like Jupyter's default interrupt_mode).
    pub async fn interrupt(&self) -> Result<()> {
        if self.remote {
            let (_, msg) = self.build("interrupt_request", json!({}));
            self.control_tx.send(msg).await?;
            return Ok(());
        }
        let mut child = self.child.lock().await;
        if let Some(c) = child.as_mut() {
            if matches!(c.try_wait(), Ok(Some(_))) {
                return Ok(());
            }
            if let Some(pid) = c.id() {
                if !self.handles.interrupt(pid) {
                    // No signal/event available: ask the kernel over the control channel.
                    let (_, msg) = self.build("interrupt_request", json!({}));
                    self.control_tx.send(msg).await?;
                }
            }
        }
        Ok(())
    }

    pub async fn shutdown(&self, restart: bool) -> Result<()> {
        if self.owned {
            let (_, msg) = self.build("shutdown_request", json!({"restart": restart}));
            let _ = self.control_tx.send(msg).await;
        }
        let mut child = self.child.lock().await;
        if let Some(mut c) = child.take() {
            let pid = c.id();
            // Let the kernel exit cleanly (flush files) before forcing it.
            let mut exited = wait_exit(&mut c, std::time::Duration::from_secs(3)).await;
            // Remote: closing the SSH session's stdin makes the bootstrap stop the kernel
            // (terminate, then kill after 3 s) and remove its connection file.
            if c.stdin.take().is_some() && !exited {
                exited = wait_exit(&mut c, std::time::Duration::from_secs(4)).await;
            }
            if !self.remote {
                // Also reap what user code left running in the kernel's process group.
                if let Some(pid) = pid {
                    platform::kill_group(pid);
                }
            }
            if !exited {
                let _ = c.start_kill();
            }
            let _ = c.wait().await;
        }
        for mut c in self.extra.lock().await.drain(..) {
            let _ = c.start_kill();
            let _ = c.wait().await;
        }
        self.cancel.cancel();
        Ok(())
    }

    pub async fn is_alive(&self) -> bool {
        self.liveness().await == Liveness::Alive
    }

    /// Whether the kernel is reachable and, if not, why (a process exit is final, a
    /// heartbeat loss may recover).
    pub async fn liveness(&self) -> Liveness {
        if self.cancel.is_cancelled() {
            return Liveness::Exited;
        }
        for c in self.extra.lock().await.iter_mut() {
            if matches!(c.try_wait(), Ok(Some(_))) {
                return Liveness::Exited; // ssh tunnel died
            }
        }
        if let Some(c) = self.child.lock().await.as_mut() {
            if !matches!(c.try_wait(), Ok(None)) {
                return Liveness::Exited;
            }
        }
        if self.link_dead.load(Ordering::Relaxed) {
            Liveness::Link
        } else if self.hb_dead.load(Ordering::Relaxed) {
            Liveness::Heartbeat
        } else {
            Liveness::Alive
        }
    }

    /// How many times a channel has been reconnected so far.
    pub fn reconnects(&self) -> u64 {
        self.reconnects.load(Ordering::Relaxed)
    }

    /// Resolves when the kernel has been shut down or dropped.
    pub async fn cancelled(&self) {
        self.cancel.cancelled().await
    }

    /// Ready means a shell kernel_info_reply *and* an iopub message (the
    /// busy/idle status) for one of our kernel_info requests: only then is the
    /// SUB subscription known to be live, so the first cell's output is not lost.
    async fn wait_ready(&self, timeout: std::time::Duration) -> Result<()> {
        let mut rx = self.subscribe();
        let deadline = tokio::time::Instant::now() + timeout;
        let mut ids: Vec<String> = vec![];
        let (mut shell, mut iopub) = (false, false);
        loop {
            if tokio::time::Instant::now() > deadline {
                anyhow::bail!("kernel did not become ready within {timeout:?}");
            }
            // A fresh request each round: its iopub status is published after the
            // subscription may have become active, unlike the earlier ones.
            ids.push(self.kernel_info().await?);
            let wait = tokio::time::timeout(std::time::Duration::from_secs(1), async {
                loop {
                    match rx.recv().await {
                        Ok(ev) if ev.msg.parent_id().is_some_and(|p| ids.iter().any(|i| i == p)) => {
                            match ev.channel {
                                Channel::Shell => shell = true,
                                Channel::IoPub => iopub = true,
                                _ => {}
                            }
                            if shell && iopub {
                                return true;
                            }
                        }
                        Ok(_) => {}
                        Err(broadcast::error::RecvError::Lagged(_)) => {}
                        Err(_) => return false,
                    }
                }
            })
            .await;
            if let Ok(true) = wait {
                return Ok(());
            }
            if !self.is_alive().await {
                anyhow::bail!("kernel process exited during startup");
            }
        }
    }
}

/// Remote bootstrap (see `launch_remote`).  Run as `python -c ... <cwd_b64> <self_b64>`.
const REMOTE_BOOTSTRAP: &str = r#"import json,os,select,signal,socket,subprocess,sys,time,uuid
d=os.path.expanduser("~/.pide/run"); os.makedirs(d,mode=0o700,exist_ok=True)
# Sweep connection files of bootstraps that no longer exist (e.g. after a host reboot).
for n in os.listdir(d):
    if n.startswith("kernel-") and n.endswith(".json"):
        try:
            os.kill(int(n[7:-5]),0)
        except ProcessLookupError:
            try: os.remove(os.path.join(d,n))
            except OSError: pass
        except (ValueError,OSError):
            pass
ls=[socket.socket() for _ in range(5)]
for s in ls: s.bind(("127.0.0.1",0))
ports=[s.getsockname()[1] for s in ls]
for s in ls: s.close()
info={"transport":"tcp","ip":"127.0.0.1","shell_port":ports[0],"iopub_port":ports[1],"stdin_port":ports[2],"control_port":ports[3],"hb_port":ports[4],"key":uuid.uuid4().hex,"signature_scheme":"hmac-sha256","kernel_name":"python3"}
f=os.path.join(d,"kernel-%d.json"%os.getpid())
with os.fdopen(os.open(f,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600),"w") as fh: json.dump(info,fh)
env=dict(os.environ)
env["PYTHONPATH"]=os.path.expanduser("~/.pide")+os.pathsep+env.get("PYTHONPATH","")
env.setdefault("MPLBACKEND","module://matplotlib_inline.backend_inline")
# ipykernel's ParentPollerUnix exits the kernel if this bootstrap dies, however it dies.
env["JPY_PARENT_PID"]=str(os.getpid())
def bye(*_): raise SystemExit(1)
for sg in (signal.SIGTERM,signal.SIGHUP): signal.signal(sg,bye)
k=None
try:
    # Kernel stdout goes to our stderr: our stdout carries only the PIDE_CONN line.  Its own
    # session/process group lets interrupt_request (killpg) reach children of user code.
    k=subprocess.Popen([sys.executable,"-m","ipykernel_launcher","-f",f],env=env,stdin=subprocess.DEVNULL,stdout=2,start_new_session=True)
    def up(p):
        try: socket.create_connection(("127.0.0.1",p),0.5).close(); return True
        except OSError: return False
    t0=time.time()
    while not all(up(p) for p in ports):
        if k.poll() is not None: sys.exit(k.returncode or 1)
        if time.time()-t0>60: sys.exit("kernel did not listen within 60 s")
        time.sleep(0.1)
    print("PIDE_CONN:"+json.dumps(info),flush=True)
    # EOF on stdin: the app closed the session, or it / its ssh client died.
    while k.poll() is None:
        if select.select([0],[],[],0.5)[0] and not os.read(0,65536): break
finally:
    signal.signal(signal.SIGTERM,signal.SIG_IGN); signal.signal(signal.SIGHUP,signal.SIG_IGN)
    if k is not None:
        def sig(s):
            try: os.killpg(k.pid,s)
            except OSError: pass
        if k.poll() is None:
            sig(signal.SIGTERM)
            try: k.wait(3)
            except subprocess.TimeoutExpired: pass
        sig(signal.SIGKILL); k.wait()
    try: os.remove(f)
    except OSError: pass
"#;

/// Poll `c` until it exits or `timeout` passes; true when it has exited.
async fn wait_exit(c: &mut Child, timeout: std::time::Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if matches!(c.try_wait(), Ok(Some(_))) {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

/// Resolves once the kernel process or one of its helper processes has exited.
async fn exited(child: &mut Option<Child>, extra: &mut [Child]) -> anyhow::Error {
    loop {
        if let Some(Ok(Some(st))) = child.as_mut().map(|c| c.try_wait()) {
            return anyhow::anyhow!("kernel process exited during startup ({st})");
        }
        for c in extra.iter_mut() {
            if let Ok(Some(st)) = c.try_wait() {
                return anyhow::anyhow!("ssh tunnel exited during startup ({st})");
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

/// What every channel supervisor of one connection attempt shares.
#[derive(Clone)]
struct ChannelShared {
    signer: Signer,
    events: broadcast::Sender<Event>,
    cancel: CancellationToken,
    link_dead: Arc<AtomicBool>,
    hb_dead: Arc<AtomicBool>,
    reconnects: Arc<AtomicU64>,
}

type DealerConn = (DealerSocket, futures_util::stream::BoxStream<'static, SocketEvent>);

/// A DEALER with our identity, connected to `endpoint`, plus its monitor (which reports
/// the peer disconnecting: a closed connection never makes `recv` fail on its own).
async fn connect_dealer(endpoint: &str, identity: &PeerIdentity, timeout: Option<std::time::Duration>) -> zeromq::ZmqResult<DealerConn> {
    // ipykernel addresses input_request to the identity of the *shell* request, so
    // shell, stdin and control must share one identity (jupyter_client uses the
    // session id).  zeromq only sends an Identity in the handshake when one is set.
    let mut opts = SocketOptions::default();
    opts.peer_identity(identity.clone());
    if let Some(t) = timeout {
        opts.connect_timeout(t);
    }
    let mut sock = DealerSocket::with_options(opts);
    let monitor = sock.monitor().boxed();
    sock.connect(endpoint).await?;
    Ok((sock, monitor))
}

/// Connect a DEALER channel and start its supervisor, which owns the socket: it sends
/// what arrives on the returned mpsc, broadcasts what it receives and, since zeromq 0.7
/// DEALERs do not reconnect, replaces the socket (same identity) when the connection
/// drops.  Requests queued meanwhile wait in the mpsc; replies the kernel sent while
/// we were disconnected are lost.  Only when reconnecting fails is the link marked dead
/// (and the mpsc closed, so senders get an error).
async fn dealer(endpoint: String, channel: Channel, identity: &str, sh: ChannelShared) -> Result<mpsc::Sender<ZmqMessage>> {
    let identity = PeerIdentity::try_from(identity.as_bytes())?;
    let first = connect_dealer(&endpoint, &identity, None).await.with_context(|| format!("connect {channel:?} {endpoint}"))?;
    let (tx, mut rx) = mpsc::channel::<ZmqMessage>(256);
    tokio::spawn(async move {
        let mut conn = Some(first);
        // A message the dropped socket handed back (no peer): sent again after reconnecting.
        let mut unsent: Option<ZmqMessage> = None;
        loop {
            let (sock, mut monitor) = match conn.take() {
                Some(c) => c,
                None => match reconnect_dealer(&endpoint, &identity, channel, &sh).await {
                    Some(c) => {
                        sh.reconnects.fetch_add(1, Ordering::Relaxed);
                        c
                    }
                    None => {
                        if !sh.cancel.is_cancelled() {
                            sh.link_dead.store(true, Ordering::Relaxed);
                        }
                        break;
                    }
                },
            };
            let (mut send_half, mut recv_half): (DealerSendHalf, _) = sock.split();
            let lost = loop {
                let m = match unsent.take() {
                    Some(m) => Some(m),
                    None => tokio::select! {
                        _ = sh.cancel.cancelled() => return,
                        m = rx.recv() => match m {
                            Some(m) => Some(m),
                            None => return, // the Kernel is gone
                        },
                        r = recv_half.recv() => {
                            match r {
                                Ok(m) => match Message::decode(m.into_vec(), &sh.signer) {
                                    Ok(msg) => {
                                        let _ = sh.events.send(Event { channel, msg });
                                    }
                                    Err(e) => tracing::warn!("{channel:?} decode: {e:#}"),
                                },
                                Err(e) => break format!("recv: {e}"),
                            }
                            None
                        }
                        ev = monitor.next() => match ev {
                            Some(SocketEvent::Disconnected(_)) | None => break "peer disconnected".to_string(),
                            Some(_) => None,
                        },
                    },
                };
                if let Some(m) = m {
                    match send_half.send(m).await {
                        Ok(()) => {}
                        Err(ZmqError::ReturnToSender { message, reason }) => {
                            unsent = Some(message);
                            break format!("send: {reason}");
                        }
                        Err(e) => break format!("send: {e}"),
                    }
                }
            };
            tracing::warn!("{channel:?} connection lost ({lost}); reconnecting");
            // Dropping both halves shuts the old socket down.
        }
    });
    Ok(tx)
}

/// Reconnect a dropped DEALER with backoff: keep trying for 30 s, and beyond that for as
/// long as the heartbeat still answers (at most 5 min).  None when cancelled or given up.
async fn reconnect_dealer(endpoint: &str, identity: &PeerIdentity, channel: Channel, sh: &ChannelShared) -> Option<DealerConn> {
    use std::time::Duration;
    let since = tokio::time::Instant::now();
    let mut delay = Duration::from_millis(100);
    loop {
        tokio::select! {
            _ = sh.cancel.cancelled() => return None,
            _ = tokio::time::sleep(delay) => {}
        }
        let r = tokio::select! {
            _ = sh.cancel.cancelled() => return None,
            r = connect_dealer(endpoint, identity, Some(Duration::from_secs(5))) => r,
        };
        match r {
            Ok(c) => {
                tracing::info!("{channel:?} reconnected after {:?}", since.elapsed());
                return Some(c);
            }
            Err(e) => tracing::debug!("{channel:?} reconnect failed: {e}"),
        }
        let waited = since.elapsed();
        if (waited > Duration::from_secs(30) && sh.hb_dead.load(Ordering::Relaxed)) || waited > Duration::from_secs(300) {
            tracing::warn!("{channel:?} could not reconnect within {waited:?}; giving up");
            return None;
        }
        delay = (delay * 2).min(Duration::from_secs(2));
    }
}

pub fn b64encode(d: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut o = String::new();
    for c in d.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        o.push(T[(n >> 18 & 63) as usize] as char);
        o.push(T[(n >> 12 & 63) as usize] as char);
        o.push(if c.len() > 1 { T[(n >> 6 & 63) as usize] as char } else { '=' });
        o.push(if c.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    o
}

/// POSIX single-quote; `~` is expanded by the remote shell only when it is the
/// whole string or a `~/` prefix with no further quoting hazards.
pub fn shell_quote(s: &str) -> String {
    if let Some(rest) = s.strip_prefix("~/") {
        return format!("~/'{}'", rest.replace('\'', "'\\''"));
    }
    if s == "~" {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\\''"))
}

async fn pipe_log<R: tokio::io::AsyncRead + Unpin>(name: &'static str, r: R, tail: Option<StderrLines>) {
    use tokio::io::AsyncBufReadExt;
    let mut lines = tokio::io::BufReader::new(r).lines();
    while let Ok(Some(l)) = lines.next_line().await {
        tracing::debug!(target: "kernel", "[{name}] {l}");
        if let Some(Ok(mut t)) = tail.as_ref().map(|t| t.lock()) {
            if t.len() == STDERR_TAIL {
                t.pop_front();
            }
            t.push_back(l);
        }
    }
}

const STDERR_TAIL: usize = 20;
type StderrLines = Arc<std::sync::Mutex<VecDeque<String>>>;

/// The last lines a starting kernel (or its SSH session) wrote to stderr, so a
/// startup failure can say why (ipykernel missing, wrong interpreter, ...).
#[derive(Default)]
struct StderrTail {
    lines: StderrLines,
    reader: Option<tokio::task::JoinHandle<()>>,
}

impl StderrTail {
    fn spawn<R: tokio::io::AsyncRead + Unpin + Send + 'static>(name: &'static str, r: R) -> Self {
        let lines = StderrLines::default();
        let reader = tokio::spawn(pipe_log(name, r, Some(lines.clone())));
        StderrTail { lines, reader: Some(reader) }
    }

    async fn annotate(mut self, e: anyhow::Error) -> anyhow::Error {
        // Give a just-exited process's pipe a moment to drain.
        if let Some(r) = self.reader.as_mut() {
            let _ = tokio::time::timeout(std::time::Duration::from_millis(500), r).await;
        }
        let lines = match self.lines.lock() {
            Ok(l) => l.iter().cloned().collect::<Vec<_>>(),
            Err(_) => vec![],
        };
        if lines.is_empty() {
            return e;
        }
        anyhow::anyhow!("{e:#}\nkernel stderr:\n{}", lines.join("\n"))
    }
}

#[allow(dead_code)]
fn _bytes(v: &[u8]) -> Bytes {
    Bytes::copy_from_slice(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_escapes_single_quotes_and_keeps_tilde() {
        assert_eq!(shell_quote("plain"), "'plain'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        assert_eq!(shell_quote("~"), "~");
        assert_eq!(shell_quote("~/my project"), "~/'my project'");
        assert_eq!(shell_quote("~/x;rm -rf ~"), "~/'x;rm -rf ~'");
    }

    #[test]
    fn b64encode_matches_standard() {
        assert_eq!(b64encode(b""), "");
        assert_eq!(b64encode(b"f"), "Zg==");
        assert_eq!(b64encode(b"fo"), "Zm8=");
        assert_eq!(b64encode(b"foo"), "Zm9v");
        assert_eq!(b64encode(b"hello world"), "aGVsbG8gd29ybGQ=");
    }

    #[test]
    fn connection_info_ports_are_distinct() {
        let i = ConnectionInfo::new_local().unwrap();
        let mut p = vec![i.shell_port, i.iopub_port, i.stdin_port, i.control_port, i.hb_port];
        p.sort();
        p.dedup();
        assert_eq!(p.len(), 5);
        assert_eq!(i.key.len(), 32);
    }
}
